import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';
import { fail,businessDate } from './security.js';

const steps=['company','details','wallets','projects','warehouses','partners','catalog','balances'];
const draftFields={company:['legalName','legalForm','taxRegime','vatRegistered'],details:['identifier','legalAddress','bankIban','bankBic','directorName','accountantName'],wallets:['name'],projects:['name'],warehouses:['name'],partners:['name','kind'],catalog:['name','kind'],balances:['balanceMode','startDate']};
export async function registerCompanySetup(app,{db,auth,access}){
 await db.exec(`CREATE TABLE IF NOT EXISTS company_setup(company_id TEXT PRIMARY KEY REFERENCES companies(id),setup_id TEXT NOT NULL,states TEXT NOT NULL DEFAULT '{}',drafts TEXT NOT NULL DEFAULT '{}',current_step TEXT NOT NULL DEFAULT 'company',version INTEGER NOT NULL DEFAULT 0,finished BOOLEAN NOT NULL DEFAULT FALSE,updated_at TEXT NOT NULL)`);
 const base='/v1/companies/:companyId/setup';
 const get=async id=>{await db.prepare('INSERT INTO company_setup(company_id,setup_id,updated_at) VALUES(?,?,?) ON CONFLICT(company_id) DO NOTHING').run(id,randomUUID(),new Date().toISOString());return db.prepare('SELECT * FROM company_setup WHERE company_id=?').get(id);};
 async function facts(company){
  const settings=await db.prepare('SELECT * FROM company_settings WHERE company_id=?').get(company.id);
  const count=async(table,filter='')=>Number((await db.prepare(`SELECT count(*) n FROM ${table} WHERE company_id=? ${filter}`).get(company.id)).n);
  const counts={wallets:await count('wallets'),projects:await count('projects'),warehouses:await count('documents',"AND kind='warehouses'"),partners:await count('documents',"AND kind IN ('clients','suppliers')"),catalog:await count('documents',"AND kind IN ('nomenklatura','services')"),balances:await count('journal')};
  return {settings:settings||{legal_name:company.name,version:0},counts};
 }
 const output=(row,f)=>({setup_id:row.setup_id,states:JSON.parse(row.states),drafts:JSON.parse(row.drafts),current_step:row.current_step,version:row.version,finished:row.finished,...f});
 app.get(base,{preHandler:auth},async req=>{const company=await access(req,'organization.write');return output(await get(company.id),await facts(company));});
 app.patch(base+'/draft',{preHandler:auth},async req=>{
  const company=await access(req,'organization.write'),body=req.body;
  if(!body||!steps.includes(body.step)||!body.data||typeof body.data!=='object'||Array.isArray(body.data))fail(400,'invalid_setup_draft');
  const data={};for(const [key,value]of Object.entries(body.data)){if(!draftFields[body.step].includes(key)||typeof value!=='string'||value.length>500)fail(400,'invalid_setup_draft');data[key]=value;}
  return transaction(db,async()=>{await db.prepare('SELECT id FROM companies WHERE id=? FOR UPDATE').get(company.id);await get(company.id);const row=await db.prepare('SELECT * FROM company_setup WHERE company_id=? FOR UPDATE').get(company.id),drafts=JSON.parse(row.drafts);
   // A late autosave must not restore a draft of an already completed step.
   if(JSON.parse(row.states)[body.step]==='done')return {saved:false};
   drafts[body.step]=data;await db.prepare('UPDATE company_setup SET drafts=?,updated_at=? WHERE company_id=?').run(JSON.stringify(drafts),new Date().toISOString(),company.id);return {saved:true};
  });
 });
 app.post(base,{preHandler:auth},async req=>{
  const company=await access(req,'organization.write'),body=req.body;
  if(!body||!Number.isInteger(body.version)||!['done','skipped','finish','resume'].includes(body.action))fail(400,'invalid_setup_action');
  return transaction(db,async()=>{
   await db.prepare('SELECT id FROM companies WHERE id=? FOR UPDATE').get(company.id);
   await get(company.id);const row=await db.prepare('SELECT * FROM company_setup WHERE company_id=? FOR UPDATE').get(company.id);
   if(row.version!==body.version)fail(409,'version_conflict');
   const states=JSON.parse(row.states),drafts=JSON.parse(row.drafts),f=await facts(company);let current=row.current_step,finished=row.finished;
   if(body.action==='finish'){
    if(!steps.every(step=>['done','skipped'].includes(states[step]))||states.company!=='done'||!f.settings.legal_form||!f.settings.tax_regime)fail(409,'setup_incomplete');finished=true;
   }else{
    if(!steps.includes(body.step))fail(400,'invalid_setup_step');
    const index=steps.indexOf(body.step);if(steps.slice(0,index).some(step=>!states[step]))fail(409,'setup_step_locked');
    if(body.action==='resume'){delete states[body.step];current=body.step;finished=false;}
    else{
     if(body.step==='company'&&body.action==='skipped')fail(400,'required_setup_step');
     if(body.action==='done'){
      if(body.step==='company'&&(!f.settings.legal_form||!f.settings.tax_regime||!f.settings.legal_name))fail(409,'setup_data_missing');
      if(body.step==='details'&&!['identifier','legal_address','bank_iban','bank_bic','director_name','accountant_name'].some(key=>f.settings[key]))fail(409,'setup_data_missing');
      if(['wallets','projects','warehouses','partners','catalog'].includes(body.step)&&!f.counts[body.step])fail(409,'setup_data_missing');
      if(body.step==='balances'){
       if(!['zero','reviewed'].includes(body.balanceMode))fail(400,'invalid_balance_review');
       if(body.balanceMode==='zero'&&f.counts.balances>0)fail(409,'balances_already_exist');
       if(body.balanceMode==='reviewed'&&f.counts.balances===0)fail(409,'setup_data_missing');
       if(typeof body.startDate!=='string')fail(400,'invalid_business_date');
       drafts.balances={balanceMode:body.balanceMode,startDate:businessDate(body.startDate,company.timezone)};
      }else delete drafts[body.step];
     }
     states[body.step]=body.action;current=steps.find(step=>!states[step])||body.step;finished=false;
    }
   }
   await db.prepare('UPDATE company_setup SET states=?,drafts=?,current_step=?,finished=?,version=version+1,updated_at=? WHERE company_id=?').run(JSON.stringify(states),JSON.stringify(drafts),current,finished,new Date().toISOString(),company.id);
   return output(await get(company.id),f);
  });
 });
}
