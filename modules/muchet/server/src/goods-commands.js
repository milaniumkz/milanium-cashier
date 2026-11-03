import { randomUUID } from 'node:crypto';
import { fail,integer,text,businessDate } from './security.js';
import { orderInput,allocate,postJournal } from './accounting.js';
import { projectOrderPayments } from './order-payments.js';
const now=()=>new Date().toISOString();

export async function getGoodsOrder(db,companyId,id){
    const row = (await db.prepare('SELECT * FROM orders WHERE company_id=? AND id=?').get(companyId, id));
    if (!row) fail(404, 'order_not_found');
    const paid=(await db.prepare('SELECT COALESCE(sum(amount),0) AS paid FROM payments WHERE company_id=? AND order_id=? AND NOT voided').get(companyId,id)).paid;
    const data=JSON.parse(row.data);
    return { ...row,data,paid,outstanding:Math.max(0,data.total-paid),customerCredit:Math.max(0,paid-data.total),revision:(await db.prepare("SELECT count(*) AS n FROM entity_history WHERE company_id=? AND kind='order' AND entity_id=?").get(companyId,id)).n };
  }

export async function createGoodsOrder(db,company,input){
    const parsed = (await orderInput(db, company.id, input,company.timezone));
    const year=Number(parsed.businessDate.substring(0,4)),sequence=(await db.prepare("INSERT INTO document_sequences(company_id,kind,year,next_number) VALUES(?,'GOODS_ORDER',?,2) ON CONFLICT(company_id,kind,year) DO UPDATE SET next_number=document_sequences.next_number+1 RETURNING next_number-1 AS number").get(company.id,year)).number;
    parsed.number=`ТН-${year}-${String(sequence).padStart(4,'0')}`;
    const id = randomUUID();
    (await db.prepare("INSERT INTO orders VALUES(?,?,'NEW',?,?)").run(id, company.id, JSON.stringify(parsed), now()));
    return { id, status: 'NEW', ...parsed };
}

export async function reserveGoodsOrder(db,company,orderId){
    const order = (await getGoodsOrder(db,company.id, orderId));
    if (order.status !== 'NEW') fail(409, 'invalid_order_state');
    for (const item of order.data.items) {
      for (const allocation of (await allocate(db, company.id, item, order.data.scope))) {
        (await db.prepare('UPDATE batches SET reserved=reserved+? WHERE id=?').run(allocation.quantity, allocation.batchId));
        (await db.prepare('INSERT INTO reservations VALUES(?,?,?)').run(order.id, allocation.batchId, allocation.quantity));
      }
    }
    (await db.prepare("UPDATE orders SET status='RESERVED' WHERE id=?").run(order.id));
    return { id: order.id, status: 'RESERVED' };
}

export async function shipGoodsOrder(db,company,orderId){
    const order = (await getGoodsOrder(db,company.id, orderId));
    if (order.status !== 'RESERVED') fail(409, 'invalid_order_state');
    let cogs = 0;
    for (const row of (await db.prepare('SELECT r.*,b.unit_cost FROM reservations r JOIN batches b ON b.id=r.batch_id WHERE r.order_id=?').all(order.id))) {
      await db.prepare('INSERT INTO shipment_allocations VALUES(?,?,?,?)').run(order.id,row.batch_id,row.quantity,row.unit_cost);
      (await db.prepare('UPDATE batches SET quantity=quantity-?,reserved=reserved-? WHERE id=?').run(row.quantity, row.quantity, row.batch_id));
      cogs += row.quantity * row.unit_cost;
    }
    integer(cogs, 'cogs');
    (await db.prepare('DELETE FROM reservations WHERE order_id=?').run(order.id));
    (await db.prepare("UPDATE orders SET status='SHIPPED' WHERE id=?").run(order.id));
    if(order.data.total){
      const posted=await postJournal(db,company,{scope:order.data.scope,businessDate:order.data.businessDate,projectId:order.data.projectId,description:`Продажа товаров ${order.id}`,lines:[{account:'receivables',debit:order.data.total},{account:'revenue',credit:order.data.net??order.data.total},...(order.data.vat?[{account:'vat_payable',credit:order.data.vat}]:[])]});
      await db.prepare('INSERT INTO order_postings VALUES(?,?,?,?)').run(company.id,order.id,posted.id,'REVENUE');
    }
    if(cogs){
      const posted=await postJournal(db,company,{scope:order.data.scope,businessDate:order.data.businessDate,projectId:order.data.projectId,description:`Себестоимость товаров ${order.id}`,lines:[{account:'cogs',debit:cogs},{account:'inventory',credit:cogs}]});
      await db.prepare('INSERT INTO order_postings VALUES(?,?,?,?)').run(company.id,order.id,posted.id,'COGS');
    }
    return { id: order.id, status: 'SHIPPED', revenue: order.data.total, cogs, grossProfit: order.data.total - cogs };
}

export async function receiveGoodsPayment(db,company,orderId,input,authorizeWallet=async()=>{}){
    const order = (await getGoodsOrder(db,company.id, orderId));
    if (order.status !== 'SHIPPED') fail(409, 'invalid_order_state');
    const amount = integer(input.amount, 'amount', 1);
    const paid = (await db.prepare('SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE order_id=? AND NOT voided').get(order.id)).total;
    if (paid + amount > order.data.total) fail(409, 'overpayment');
    const body=input,date=businessDate(body.businessDate,company.timezone);
    const id=randomUUID();let cashAccount='cash',walletId=null;
    if(body.walletId!==undefined){
      await authorizeWallet();
      const wallet=await db.prepare('SELECT * FROM wallets WHERE company_id=? AND id=?').get(company.id,text(body.walletId,'walletId'));
      if(!wallet)fail(404,'wallet_not_found');if(wallet.scope!==order.data.scope)fail(400,'incompatible_ledger_scope');
      walletId=wallet.id;cashAccount=`wallet:${wallet.id}`;
    }
    const posting=await postJournal(db,company,{scope:order.data.scope,projectId:order.data.projectId,businessDate:date,description:`Оплата товаров ${id}`,lines:[{account:cashAccount,debit:amount},{account:'receivables',credit:amount}]});
    await db.prepare('INSERT INTO payments(id,company_id,order_id,amount,created_at,wallet_id,journal_id,business_date) VALUES(?,?,?,?,?,?,?,?)').run(id,company.id,order.id,amount,now(),walletId,posting.id,date);
    if(walletId)await db.prepare('INSERT INTO wallet_entries(id,company_id,wallet_id,amount,kind,reference_id,created_at,journal_id) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),company.id,walletId,amount,'ORDER_PAYMENT',id,now(),posting.id);
    await projectOrderPayments(db,company,order);
    if (paid + amount === order.data.total) (await db.prepare("UPDATE orders SET status='CLOSED' WHERE id=?").run(order.id));
    return { id, orderId: order.id, amount, outstanding: order.data.total - paid - amount };
}
