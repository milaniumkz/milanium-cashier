import {AppError} from './db.js';
export class OpenAIClient{
 constructor({fetchImpl=fetch}={}){this.fetch=fetchImpl;}
 async respond({key,model,instructions,input,maxOutputTokens,reference}){
  let response,data;try{response=await this.fetch('https://api.openai.com/v1/responses',{method:'POST',redirect:'error',signal:AbortSignal.timeout(60000),headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json','X-Client-Request-Id':reference},body:JSON.stringify({model,store:false,instructions,input,max_output_tokens:maxOutputTokens,text:{format:{type:'json_schema',name:'sales_action',strict:true,schema:{type:'object',additionalProperties:false,properties:{action:{type:'string',enum:['reply','quote','handoff']},text:{type:'string'},items:{type:'array',maxItems:10,items:{type:'object',additionalProperties:false,properties:{productId:{type:'string'},quantity:{type:'integer',minimum:1,maximum:1000}},required:['productId','quantity']}}},required:['action','text','items']}}}})});data=await response.json();}catch{throw new AppError('AI_RESULT_UNKNOWN','Результат AI неизвестен. Резерв сохранён до сверки.',502);}
  if(!response.ok){if(response.status>=500)throw new AppError('AI_RESULT_UNKNOWN','AI-провайдер вернул серверную ошибку. Резерв сохранён до сверки.',502);const e=new AppError('AI_PROVIDER_REJECTED','AI-провайдер отклонил запрос. Проверьте ключ, модель и лимиты.',409);e.confirmedRejected=true;throw e;}
  if(typeof data.id!=='string'||!data.usage)throw new AppError('AI_RESULT_UNKNOWN','AI не вернул подтверждённый расход. Нужна сверка.',502);
  return {id:data.id,status:data.status,usage:data.usage,text:(data.output||[]).filter(x=>x.type==='message').flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('')};
 }
}
