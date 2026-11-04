import {spawnSync} from 'node:child_process';
const result=spawnSync('python3',['-c',`
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_STORED
root=Path('browser-extension')
files=['manifest.json','config.js','background.js','page-adapter.js','popup.html','popup.js','popup.css']
output=Path('public/mbusiness-browser-extension.zip')
with ZipFile(output.with_suffix('.tmp'), 'w') as archive:
 for name in files:
  info=ZipInfo(name,(2026,1,1,0,0,0));info.compress_type=ZIP_STORED;info.external_attr=0o100644<<16
  archive.writestr(info,(root/name).read_bytes())
output.with_suffix('.tmp').replace(output)
print('Packaged MBusiness Chrome extension.')
`],{stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);
