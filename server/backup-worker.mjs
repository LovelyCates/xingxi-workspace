import { parentPort, workerData } from 'node:worker_threads';
import { createBackup, verifyBackup, restoreBackup } from './backup-core.mjs';
import { Fault } from './store.mjs';
try {
  const { operation, source, destination } = workerData;
  const result =
    operation === 'create'
      ? await createBackup(source, destination)
      : operation === 'restore'
        ? await restoreBackup(source, destination)
        : operation === 'verify'
          ? await verifyBackup(source)
          : (() => {
              throw new Fault('未知备份操作');
            })();
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  const message =
    error instanceof Fault
      ? error.message
      : error.code === 'EEXIST'
        ? '目标已存在，请选择一个全新的目录'
        : error.code === 'ENOENT'
          ? '备份文件或父目录不存在'
          : '备份操作失败，请检查文件权限、磁盘空间与数据库状态';
  parentPort.postMessage({ ok: false, error: message });
}
