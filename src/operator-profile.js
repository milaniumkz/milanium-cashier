import {z} from 'zod';
import {AppError} from './db.js';
import {seal,unseal} from './crypto.js';
export function registerOperatorProfile(app,{store,config,admin}){
 const db=store.db;db.exec('CREATE TABLE IF NOT EXISTS operator_profile(id INTEGER PRIMARY KEY CHECK(id=1),secret TEXT NOT NULL)');
 const schema=z.object({legal_name:z.string().trim().min(2).max(200),identifier:z.string().regex(/^(?:\d{12})?$/).default(''),address:z.string().trim().min(5).max(500),support_email:z.email().max(200)}).strict();
 if(config.operatorProfile&&!db.prepare('SELECT 1 FROM operator_profile WHERE id=1').get()){const profile=schema.parse(config.operatorProfile);db.prepare('INSERT INTO operator_profile VALUES(1,?)').run(seal(profile,config.key,'operator-profile'));}
 const read=()=>{const row=db.prepare('SELECT secret FROM operator_profile WHERE id=1').get();return row?unseal(row.secret,config.key,'operator-profile'):null;};
 app.get('/admin/operator-profile',{preHandler:admin},async()=>read()||{legal_name:'',identifier:'',address:'',support_email:''});
 app.put('/admin/operator-profile',{preHandler:admin},async req=>{const b=schema.parse(req.body);db.prepare('INSERT INTO operator_profile VALUES(1,?) ON CONFLICT(id) DO UPDATE SET secret=excluded.secret').run(seal(b,config.key,'operator-profile'));return {ok:true};});
 app.get('/legal/operator',async()=>{const p=read();if(!p)throw new AppError('OPERATOR_NOT_CONFIGURED','Контакты оператора ещё не опубликованы. Обратитесь к владельцу MBusiness.',503);return {legal_name:p.legal_name,address:p.address,support_email:p.support_email};});
}
