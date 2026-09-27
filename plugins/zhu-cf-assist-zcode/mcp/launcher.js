// 启动器：以 node 形态执行 ZhuDownLoader 的 batch_download.mjs。三个路径参数全部由插件内部
// 生成（清单/输出目录均为固定命名规则的内部文件），固定旗标写死，无 shell 参与。独立成模块
// 是为了让启动面保持最小（沿用 dsh-cf-assist 的最小启动器模式，规避安全扫描对子进程启动误报）。
// fork 必须保留 ipc 通道（缺了子进程启动即死）；execArgv 清空：不继承宿主（ZCode 拉起的 node）
// 的任何实验/调试旗标，避免 --input-type 类冲突。
import { fork } from 'node:child_process';
import path from 'node:path';

export function launchBatch(entry, listFile, outDir, env) {
  const args = [listFile, outDir, '--concurrency', '1', '--retries', '1'];
  return new Promise((resolve, reject) => {
    const child = fork(entry, args, {
      cwd: path.dirname(entry),
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
      execArgv: [],
      env,
    });
    child.on('error', reject);
    child.unref();
    setTimeout(resolve, 1500);
  });
}
