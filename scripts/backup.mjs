import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupTask } from '../server/backups.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [operation, sourceArg, flag, destinationArg] = process.argv.slice(2);
const dir = resolve(process.env.XINGXI_DATA_DIR || resolve(root, '.local'));
try {
  let input;
  if (operation === 'create' && sourceArg && !flag)
    input = { operation, source: resolve(dir, 'xingxi.sqlite'), destination: resolve(sourceArg) };
  else if (operation === 'verify' && sourceArg && !flag)
    input = { operation, source: resolve(sourceArg) };
  else if (operation === 'restore' && sourceArg && flag === '--to' && destinationArg)
    input = { operation, source: resolve(sourceArg), destination: resolve(destinationArg) };
  else
    throw new Error(
      '用法：npm run backup -- create 新备份目录 | verify 备份目录 | restore 备份目录 --to 全新数据目录',
    );
  console.log(JSON.stringify(await backupTask(input), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
