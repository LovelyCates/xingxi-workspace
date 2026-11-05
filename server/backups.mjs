import { Worker } from 'node:worker_threads';
import { mkdir, readdir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Fault, uid, now } from './store.mjs';
import { readManifest } from './backup-core.mjs';

export function backupTask(input) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./backup-worker.mjs', import.meta.url), {
      workerData: input,
    });
    const timer = setTimeout(
      () => {
        worker.terminate();
        reject(new Fault('备份操作超时，完成状态未确认；请检查备份列表后重试'));
      },
      10 * 60 * 1000,
    );
    worker.once('message', (message) => {
      clearTimeout(timer);
      message.ok ? resolve(message.result) : reject(new Fault(message.error));
    });
    worker.once('error', () => {
      clearTimeout(timer);
      reject(new Fault('备份工作进程失败，请检查 Node 版本与本机资源'));
    });
    worker.once('exit', () => {
      clearTimeout(timer);
      reject(new Fault('备份工作进程未返回完成结果'));
    });
  });
}
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export class Backups {
  constructor(dir) {
    this.dir = resolve(dir);
    this.root = join(this.dir, 'backups');
    this.active = null;
    this.pending = Promise.resolve();
  }
  async rootReady() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.root)).isDirectory() || (await lstat(this.root)).isSymbolicLink())
      throw new Fault('备份目录不能是符号链接');
  }
  async list() {
    await this.rootReady();
    const items = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
      try {
        items.push({
          id: entry.name,
          path: join(this.root, entry.name),
          ...(await readManifest(join(this.root, entry.name))),
        });
      } catch {
        /* Incomplete directories are not published backups. */
      }
    }
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { items: items.slice(0, 20), total: items.length, active: this.active, root: this.root };
  }
  async start(operation, id) {
    if (this.active?.status === 'running') throw new Fault('已有备份操作正在进行，请稍候', 409);
    if (!['create', 'verify', 'restore'].includes(operation)) throw new Fault('未知备份操作');
    if (operation !== 'create' && !idPattern.test(id || '')) throw new Fault('备份标识无效');
    // Set busy before any await so two requests cannot start concurrent copies.
    const job = (this.active = { id: uid(), operation, status: 'running', startedAt: now() });
    this.pending = (async () => {
      try {
        await this.rootReady();
        const backupId = operation === 'create' ? uid() : id;
        const source =
          operation === 'create' ? join(this.dir, 'xingxi.sqlite') : join(this.root, backupId);
        if (
          operation !== 'create' &&
          ((await lstat(source)).isSymbolicLink() || !(await lstat(source)).isDirectory())
        )
          throw new Fault('备份目录无效');
        const destination =
          operation === 'create'
            ? join(this.root, backupId)
            : operation === 'restore'
              ? join(this.dir, `restored-${uid()}`)
              : undefined;
        job.result = await backupTask({ operation, source, destination });
        job.status = 'done';
      } catch (error) {
        job.status = 'failed';
        job.error = error instanceof Fault ? error.message : '备份操作失败，请检查本机文件';
      }
      job.finishedAt = now();
    })();
    return { ...job };
  }
}
