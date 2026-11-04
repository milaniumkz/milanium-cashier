const read=['catalog.read','organization.read','inventory.read','orders.read','accounting.read','files.read','wallets.read','debts.read','shifts.read','reports.read','documents.read','documents.export','tax-calendar.read','assets.read','bank.read','projects.read'];
const retail=['catalog.read','inventory.read','orders.read','orders.write','orders.fulfill','orders.edit','payments.write','wallets.read','wallets.transact','shifts.read','shifts.write','files.read'];
const crm=['marketing.read','marketing.write','crm.read','crm.write','messages.read','messages.send','ai.use'];
const accounting=[...read,'catalog.write','organization.write','accounting.post','accounting.edit','payments.write','files.write','wallets.write','wallets.transact','debts.write','debts.settle','periods.close','documents.write','documents.post','documents.settle','tax-calendar.write','payroll.read','payroll.write','payroll.post','payroll.settle','employees.read','assets.write','assets.post','bank.import','bank.review','bank.post','projects.write'];
const stock=['catalog.read','catalog.write','inventory.read','inventory.count','inventory.receive','inventory.move','inventory.writeoff','orders.read','files.read','files.write'];
export const teamRoles=Object.freeze({
 manager:{name:'Управляющий',permissions:[...new Set([...accounting,...retail,...stock,...crm,'audit.read','automation.manage'])]},
 accountant:{name:'Бухгалтер',permissions:[...new Set(accounting)]},
 cashier:{name:'Кассир',permissions:retail},
 warehouse:{name:'Склад',permissions:stock},
 sales:{name:'Менеджер продаж',permissions:[...crm,'catalog.read','inventory.read','orders.read','documents.read','files.read','files.write','projects.read']},
 viewer:{name:'Наблюдатель',permissions:read}
});
export const teamRole=role=>Object.hasOwn(teamRoles,role)?teamRoles[role]:null;
