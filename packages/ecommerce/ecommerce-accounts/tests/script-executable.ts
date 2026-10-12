/**
 * A Node script that tests can start as a program. Elsewhere the script itself is the program (its
 * `#!/usr/bin/env node` line runs it); Windows starts only executables, so there the script gets an
 * `.exe` that runs `node <script>` with the same arguments and waits for it. The `.exe` is a small C#
 * program compiled once with the .NET Framework compiler that Windows ships. Killing the `.exe` ends
 * the script too, and the script sees NODE_SHIM_PARENT=1, its parent being the program others started.
 */
import { execFile } from 'node:child_process'
import { access, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const SHIM = `using System; using System.Diagnostics; using System.IO; using System.Runtime.InteropServices;
class Shim {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long a, b; public uint flags; public UIntPtr c, d; public uint e; public UIntPtr f; public uint g, h; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic basic; public Io io; public UIntPtr p, q, r, s; }
  [DllImport("kernel32.dll")] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended info, uint size);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  static int Main() {
    string self = Process.GetCurrentProcess().MainModule.FileName;
    string[] target = File.ReadAllLines(self + ".txt");
    string line = Environment.CommandLine;
    string rest = line.StartsWith("\\"") ? line.Substring(line.IndexOf('"', 1) + 1) : (line.IndexOf(' ') < 0 ? "" : line.Substring(line.IndexOf(' ')));
    // Killing this process closes the job, which ends the script with it (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE).
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    Extended info = new Extended();
    info.basic.flags = 0x2000;
    SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(Extended)));
    ProcessStartInfo start = new ProcessStartInfo(target[0], "\\"" + target[1] + "\\"" + rest);
    start.UseShellExecute = false;
    start.EnvironmentVariables["NODE_SHIM_PARENT"] = "1";
    Process child = Process.Start(start);
    AssignProcessToJobObject(job, child.Handle);
    child.WaitForExit();
    return child.ExitCode;
  }
}
`

let compiled: Promise<string> | undefined

/** Compile the shim once per test process. */
function compileShim(): Promise<string> {
  compiled ??= (async () => {
    const dir = join(tmpdir(), `dsh-node-shim-${String(process.pid)}`)
    await mkdir(dir, { recursive: true })
    const source = join(dir, 'shim.cs')
    const exe = join(dir, 'shim.exe')
    await writeFile(source, SHIM)
    const csc = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
    await promisify(execFile)(csc, ['/nologo', '/optimize', `/out:${exe}`, source])
    return exe
  })()
  return compiled
}

/**
 * The program that runs a Node script.
 * @param script - the script's path.
 * @param dir - where a Windows `.exe` for it goes.
 * @param platform - the platform to prepare for.
 * @returns the script on POSIX, else an `.exe` beside it in `dir` named after it.
 */
export async function scriptExecutable(script: string, dir: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  if (platform !== 'win32') return script
  const exe = join(dir, `${basename(script).replace(/\.[cm]?js$/u, '')}.exe`)
  const ready = await access(exe).then(() => true, () => false)
  if (!ready) {
    await mkdir(dir, { recursive: true })
    await copyFile(await compileShim(), exe)
    await writeFile(`${exe}.txt`, `${process.execPath}\r\n${script}\r\n`)
  }
  return exe
}
