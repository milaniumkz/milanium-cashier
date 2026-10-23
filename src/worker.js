import { now } from './db.js';

export class Worker {
  constructor(store, driver, config) { this.store = store; this.driver = driver; this.config = config; this.busy = new Set(); this.active = new Set(); this.stopping = false; }
  async create(i) {
    const m = this.store.merchant(i.merchant_id);
    this.store.patch(i.id, { status: 'processing', error_code: null });
    try {
      const result = await this.driver.create(m, i, () => this.store.patch(i.id, { submitted: 1 }));
      this.store.patch(i.id, { ...result, status: 'pending', next_poll: now(), error_code: null });
    } catch (e) {
      const current = this.store.invoice(i.id);
      const uncertain = current.submitted || e.uncertain;
      const auth = e.code === 'AUTH_REQUIRED';
      if (auth) this.store.setMerchantState(m.id, 'requires_auth');
      this.store.patch(i.id, { status: uncertain ? 'unknown' : auth ? 'requires_auth' : 'failed', error_code: e.code || 'CONNECTOR_ERROR', next_poll: now() + this.config.pollMs });
    }
  }
  async poll(i) {
    try {
      const status = await this.driver.poll(this.store.merchant(i.merchant_id), i);
      if (!['pending', 'paid', 'declined', 'expired'].includes(status)) throw new Error('Unexpected status');
      this.store.patch(i.id, { status, error_code: null, next_poll: now() + this.config.pollMs, polled_at: now() });
    } catch (e) {
      if (e.code === 'AUTH_REQUIRED') this.store.setMerchantState(i.merchant_id, 'requires_auth');
      this.store.patch(i.id, { status: 'unknown', error_code: e.code || 'STATUS_CHECK_FAILED', next_poll: now() + this.config.pollMs * 4 });
    }
  }
  launch(i, fn) {
    this.busy.add(i.merchant_id);
    const promise = fn.call(this, i).catch(() => {}).finally(() => { this.busy.delete(i.merchant_id); this.active.delete(promise); });
    this.active.add(promise);
  }
  tick() {
    if (this.stopping) return;
    // Poll first so a busy stream of new orders cannot starve confirmations.
    for (let n = 0; n < 4 && this.busy.size < 4; n++) {
      const p = this.store.nextPoll(this.busy, i=>(this.config.mode!=='android'||this.store.merchant(i.merchant_id).state==='connected')&&(!this.driver.canPoll||this.driver.canPoll(i)));
      if (p) this.launch(p, this.poll);
      else {
        const disconnected=this.config.mode==='android'?this.store.merchants().filter(m=>m.state!=='connected').map(m=>m.id):[];
        const blocked=new Set([...this.busy,...this.store.blockedMerchants(),...(this.driver.blockedMerchants?.()||[]),...disconnected]);
        const i = this.store.nextJob(blocked);
        if (!i) break;
        this.launch(i, this.create);
      }
    }
  }
  start() { this.timer = setInterval(() => this.tick(), 500); }
  async stop() { this.stopping = true; clearInterval(this.timer); await Promise.allSettled([...this.active]); await this.driver.close(); }
}
