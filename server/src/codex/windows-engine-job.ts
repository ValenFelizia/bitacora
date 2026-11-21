import koffi from "koffi";

const kernel = koffi.load("kernel32.dll");
const create = kernel.func("void * __stdcall CreateJobObjectW(void *, str16)");
const configure = kernel.func("int __stdcall SetInformationJobObject(void *, int, void *, uint32)");
const open = kernel.func("void * __stdcall OpenProcess(uint32, int, uint32)");
const assign = kernel.func("int __stdcall AssignProcessToJobObject(void *, void *)");
const query = kernel.func("int __stdcall QueryInformationJobObject(void *, int, void *, uint32, void *)");
const terminate = kernel.func("int __stdcall TerminateJobObject(void *, uint32)");
const close = kernel.func("int __stdcall CloseHandle(void *)");

export interface EngineJob {
  active(): boolean;
  terminate(): void;
  close(): void;
}

/** Own the descendants even if the app-server exits before they do. */
export function ownWindowsEngine(pid: number): EngineJob {
  const job = create(null, null);
  if (!job) throw new Error("Could not create engine job");
  try {
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION on Windows x64 and ARM64.
    const limits = Buffer.alloc(144);
    limits.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!configure(job, 9, limits, limits.length)) throw new Error("Could not configure engine job");
    const process = open(0x101, 0, pid); // PROCESS_SET_QUOTA | PROCESS_TERMINATE
    if (!process) throw new Error("Could not open engine process");
    try {
      if (!assign(job, process)) throw new Error("Could not own engine process");
    } finally { close(process); }
  } catch (error) {
    close(job);
    throw error;
  }
  return {
    active() {
      // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION.ActiveProcesses
      const accounting = Buffer.alloc(48);
      if (!query(job, 1, accounting, accounting.length, null)) throw new Error("Could not check engine job");
      return accounting.readUInt32LE(40) !== 0;
    },
    terminate() { terminate(job, 1); },
    close() { close(job); },
  };
}
