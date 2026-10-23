import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { AndroidDriver } from '../src/drivers/android.js';
import { assertServerStopped } from './maintenance.mjs';
process.umask(0o077);
const config=loadConfig();if(config.mode!=='android')throw new Error('Set DRIVER_MODE=android first.');
assertServerStopped(config);
const id=process.argv[2];if(!id)throw new Error('Usage: npm run connect -- MERCHANT_ID');
const store=new Store(config),merchant=store.merchant(id);
if(!merchant)throw new Error('Create the merchant in the dashboard first.');
if(!store.session(id))throw new Error('Bind an Android first: npm run android -- bind MERCHANT_ID UDID SYSTEM_PORT');
const rl=createInterface({input:process.stdin,output:process.stdout});const driver=new AndroidDriver(config,store);
try{
  console.log('Open this company’s Android emulator/device and log in to the installed app yourself.');
  console.log('Enter SMS codes only inside the Android app. This terminal does not collect credentials.');
  await rl.question('When the cashier home screen is open, press Enter here. ');
  await driver.verify(merchant);console.log('Android cashier verified. Start the service to process queued payments.');
}finally{rl.close();await driver.close();store.close();}
