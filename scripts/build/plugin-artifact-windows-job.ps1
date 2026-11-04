param(
  [ValidateSet('attach', 'query')][string]$Mode,
  [string]$JobName,
  [int]$OwnerPid = 0
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# A build needs only Node and Windows PowerShell, not a prebuilt Rust tool or
# a sandbox profile. Keep the OS interop here; the existing Node lease owner
# chooses when to attach/query it. No breakaway flags are enabled.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

public static class CogniaPluginArtifactJob {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long PerProcessUserTime, PerJobUserTime;
    public uint Flags;
    public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations;
    public ulong ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Accounting {
    public long TotalUserTime, TotalKernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);

  static uint Count(IntPtr job) {
    Accounting info;
    if (!QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    return info.ActiveProcesses;
  }

  public static bool Active(string name) {
    IntPtr job = OpenJobObject(4, false, name); // JOB_OBJECT_QUERY
    if (job == IntPtr.Zero) {
      int error = Marshal.GetLastWin32Error();
      if (error == 2) return false; // ERROR_FILE_NOT_FOUND, not access denied
      throw new Win32Exception(error);
    }
    try { return Count(job) != 0; }
    finally { CloseHandle(job); }
  }

  public static void Guard(string name, int pid) {
    IntPtr job = CreateJobObject(IntPtr.Zero, name);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    int creationError = Marshal.GetLastWin32Error();
    try {
      if (creationError == 183) throw new InvalidOperationException("Artifact job name already exists");
      ExtendedLimits limits = new ExtendedLimits();
      // A killed guardian must not leave an unprotected compiler family alive.
      limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      IntPtr process = OpenProcess(0x0101, false, pid); // SET_QUOTA | TERMINATE
      if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        if (!AssignProcessToJobObject(job, process))
          throw new Win32Exception(Marshal.GetLastWin32Error());
      } finally { CloseHandle(process); }
      Console.WriteLine("ready:" + name);
      while (Count(job) != 0) Thread.Sleep(100);
    } finally { CloseHandle(job); }
  }
}
'@

try {
  if ($Mode -eq 'attach') {
    [CogniaPluginArtifactJob]::Guard($JobName, $OwnerPid)
  } else {
    if ([CogniaPluginArtifactJob]::Active($JobName)) { 'active' } else { 'idle' }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
