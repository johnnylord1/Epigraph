using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.IO;
using System.IO.Pipes;

// Kill-on-close applies only to the suspended, unpublished root. After
// publication, individual validated handles preserve persistent services.
public static class EpigraphProcessNative {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
        public int cb; public string reserved, desktop, title;
        public int x,y,xsize,ysize,xchars,ychars,fill,flags; public short show, reserved2;
        public IntPtr reservedPtr, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup startup; public IntPtr attributes; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, EntryPoint="CreateProcessW", SetLastError=true)] static extern bool CreateProcessEx(string app, StringBuilder args, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref StartupEx startup, out ProcessInfo info);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll")] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr data, int size);
    [StructLayout(LayoutKind.Sequential)] struct BasicInfo { public IntPtr exit, peb, affinity, priority, pid, parent; }
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int kind, ref BasicInfo data, int size, out int returned);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder args, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attr, string name);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll")] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr data, int size, out int returned);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out long created, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder path, ref int size);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint pid);
    [DllImport("advapi32.dll", SetLastError=true)] static extern uint GetSecurityInfo(IntPtr handle, int type, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr descriptor, uint revision, uint info, out IntPtr text, out uint length);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr arg);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint msg, IntPtr w, IntPtr l);
    delegate bool WindowCallback(IntPtr window, IntPtr arg);

    public class Identity {
        public int Pid, ParentPid; public string Created, Executable, Job; public long Window;
    }
    public sealed class Ticket : IDisposable {
        internal IntPtr Process, Thread, Job;
        public Identity Identity;
        public void Resume() {
            // The suspended root is now durably recorded. Disable startup-only
            // kill-on-close BEFORE it can create any persistent descendants.
            SetStartupContainment(Job,false);
            if (ResumeThread(Thread)==uint.MaxValue) throw new InvalidOperationException("Cannot resume owned process");
        }
        public bool Abort() { return TerminateProcess(Process,1) && WaitForSingleObject(Process,5000)==0; }
        public bool RootExitConfirmed() { return WaitForSingleObject(Process,0)==0; }
        public void Dispose() { CloseHandle(Thread); CloseHandle(Process); CloseHandle(Job); }
    }
    static void SetStartupContainment(IntPtr job, bool enabled) {
        // JOBOBJECT_EXTENDED_LIMIT_INFORMATION: LimitFlags at offset 16 on
        // Windows x86/x64. Zero all remaining fields; set no other limits.
        int size=IntPtr.Size==8 ? 144 : 112; IntPtr data=Marshal.AllocHGlobal(size);
        try {
            for(int i=0;i<size;i++) Marshal.WriteByte(data,i,0);
            Marshal.WriteInt32(data,16,enabled ? 0x2000 : 0);
            if(!SetInformationJobObject(job,9,data,size)) throw new InvalidOperationException("Cannot configure startup containment");
        } finally { Marshal.FreeHGlobal(data); }
    }
    static Identity Read(IntPtr process, int pid, string job) {
        long created, exit, kernel, user; int size=32768; var path=new StringBuilder(size);
        if (WaitForSingleObject(process,0)!=258 || !GetProcessTimes(process,out created,out exit,out kernel,out user) ||
            !QueryFullProcessImageName(process,0,path,ref size)) return null;
        var basic=new BasicInfo(); int returned;
        if(NtQueryInformationProcess(process,0,ref basic,Marshal.SizeOf(basic),out returned)<0) return null;
        return new Identity { Pid=pid, ParentPid=basic.parent.ToInt32(), Created=created.ToString(), Executable=path.ToString(), Job=job };
    }
    public static Ticket StartSuspended(string exe, string arguments, string cwd, string jobName) {
        IntPtr job=CreateJobObject(IntPtr.Zero,jobName);
        if(job==IntPtr.Zero) throw new Win32Exception();
        if(Marshal.GetLastWin32Error()==183) { CloseHandle(job); throw new InvalidOperationException("Run already exists"); }
        ProcessInfo info; var startup=new StartupEx(); startup.startup.cb=Marshal.SizeOf(startup); startup.startup.flags=1; startup.startup.show=0;
        IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
        IntPtr attributes=Marshal.AllocHGlobal(size), jobValue=Marshal.AllocHGlobal(IntPtr.Size);
        bool initialized=false;
        try {
            SetStartupContainment(job,true);
            initialized=InitializeProcThreadAttributeList(attributes,1,0,ref size);
            if(!initialized) throw new Win32Exception();
            Marshal.WriteIntPtr(jobValue,job); startup.attributes=attributes;
            if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x2000D),jobValue,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero)) throw new Win32Exception();
            // Atomic process creation into the job closes the pre-assignment gap.
            if(!CreateProcessEx(exe,new StringBuilder("\""+exe+"\" "+arguments),IntPtr.Zero,IntPtr.Zero,false,0x08080004,IntPtr.Zero,cwd,ref startup,out info)) throw new Win32Exception();
        } catch { CloseHandle(job); throw; }
        finally { if(initialized) DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); Marshal.FreeHGlobal(jobValue); }
        var ticket=new Ticket { Process=info.process, Thread=info.thread, Job=job };
        try {
            bool member;
            if(!IsProcessInJob(info.process,job,out member) || !member) throw new InvalidOperationException("Cannot establish kernel run ownership");
            ticket.Identity=Read(info.process,(int)info.pid,jobName);
            if(ticket.Identity==null) throw new InvalidOperationException("Cannot capture owned identity");
            return ticket;
        } catch { ticket.Abort(); ticket.Dispose(); throw; }
    }
    public static Identity[] Snapshot(string jobName) {
        var list=new List<Identity>(); IntPtr job=OpenJobObject(4,false,jobName);
        if(job==IntPtr.Zero) throw new InvalidOperationException("Run job cannot be opened; evidence is unverifiable");
        // Bounded snapshot; failure/overflow never grants ownership.
        int size=8+4096*IntPtr.Size; IntPtr data=Marshal.AllocHGlobal(size);
        try {
            int returned;
            if(!QueryInformationJobObject(job,3,data,size,out returned)) throw new InvalidOperationException("Run membership query failed");
            int count=Marshal.ReadInt32(data,4);
            if(count<0 || count>4096) throw new InvalidOperationException("Run inventory overflow");
            for(int i=0;i<count;i++) {
                int pid=Marshal.ReadIntPtr(data,8+i*IntPtr.Size).ToInt32();
                IntPtr process=OpenProcess(0x101000,false,pid);
                if(process==IntPtr.Zero) throw new InvalidOperationException("Candidate cannot be opened; cleanup unconfirmed");
                try {
                    bool member;
                    if(!IsProcessInJob(process,job,out member) || !member) throw new InvalidOperationException("Candidate membership changed; cleanup unconfirmed");
                    var identity=Read(process,pid,jobName);
                    if(identity!=null) list.Add(identity);
                    else if(WaitForSingleObject(process,0)!=0) throw new InvalidOperationException("Candidate identity unavailable");
                } finally { CloseHandle(process); }
            }
            EnumWindows(delegate(IntPtr window,IntPtr unused) {
                uint pid; GetWindowThreadProcessId(window,out pid);
                if(IsWindowVisible(window)) foreach(var entry in list) if(entry.Pid==pid) {
                    // Multiple visible windows for one process are ambiguous too.
                    entry.Window=entry.Window==0 ? window.ToInt64() : -1;
                }
                return true;
            },IntPtr.Zero);
            return list.ToArray();
        } finally { Marshal.FreeHGlobal(data); CloseHandle(job); }
    }
    public static bool Act(Identity expected, string action) {
        IntPtr job=OpenJobObject(4,false,expected.Job);
        if(job==IntPtr.Zero) return false;
        IntPtr process=OpenProcess(0x101001,false,expected.Pid);
        try {
            if(process==IntPtr.Zero) return false;
            bool member;
            if(!IsProcessInJob(process,job,out member) || !member) return false;
            var actual=Read(process,expected.Pid,expected.Job);
            if(actual==null || actual.Created!=expected.Created || !String.Equals(actual.Executable,expected.Executable,StringComparison.OrdinalIgnoreCase)) return false;
            if(action=="verify") return true;
            if(action=="focus") {
                // HWND lookup/reuse is not an exact-instance capability.
                return false;
            }
            if(action!="stop") return false;
            // A desktop may spawn a runtime at any instant. Until a scoped
            // graceful-shutdown acknowledgement exists, never force-stop it.
            if(String.Equals(System.IO.Path.GetFileName(actual.Executable),"epigraph.exe",StringComparison.OrdinalIgnoreCase)) return false;
            return TerminateProcess(process,1) && WaitForSingleObject(process,5000)==0;
        } finally { if(process!=IntPtr.Zero) CloseHandle(process); CloseHandle(job); }
    }
    // Caller must supply the retained System.Diagnostics.Process returned by
    // Start, never GetProcessById or a deserialized PID record.
    public static bool StopRetained(System.Diagnostics.Process process) {
        IntPtr handle=process.Handle;
        if(WaitForSingleObject(handle,0)==0) return true;
        if(WaitForSingleObject(handle,0)!=258) return false;
        return TerminateProcess(handle,1) && WaitForSingleObject(handle,5000)==0;
    }

    public sealed class Observation : IDisposable {
        internal IntPtr Process, Job;
        public Identity Identity;
        public bool Wait(int milliseconds) { return milliseconds >= 0 && WaitForSingleObject(Process,(uint)milliseconds)==0; }
        public void Dispose() { if(Process!=IntPtr.Zero) CloseHandle(Process); if(Job!=IntPtr.Zero) CloseHandle(Job); Process=Job=IntPtr.Zero; }
    }
    // Read-only identity and membership through one retained process object.
    public static Observation Observe(Identity expected) {
        var value = new Observation { Job=OpenJobObject(4,false,expected.Job), Process=OpenProcess(0x101000,false,expected.Pid) };
        try {
            bool member;
            if(value.Job==IntPtr.Zero || value.Process==IntPtr.Zero || !IsProcessInJob(value.Process,value.Job,out member) || !member)
                throw new InvalidOperationException("Candidate job membership unavailable");
            value.Identity=Read(value.Process,expected.Pid,expected.Job);
            if(value.Identity==null || value.Identity.Created!=expected.Created || !String.Equals(value.Identity.Executable,expected.Executable,StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Candidate identity does not match recorded birth");
            return value;
        } catch { value.Dispose(); throw; }
    }
    public sealed class ControlConnection : IDisposable {
        Observation observation; NamedPipeClientStream pipe;
        public static ControlConnection Open(string runId, Identity expected, int timeout) {
            Guid run;
            if(!Guid.TryParseExact(runId,"D",out run) || run==Guid.Empty || run.ToString()!=runId || expected.Job!="Local\\Epigraph-"+runId)
                throw new InvalidOperationException("Invalid run identity");
            var connection=new ControlConnection();
            try {
                connection.observation=Observe(expected);
                connection.pipe=new NamedPipeClientStream(".","Epigraph-"+runId,PipeDirection.InOut,PipeOptions.Asynchronous);
                connection.pipe.Connect(timeout);
                uint server;
                if(!GetNamedPipeServerProcessId(connection.pipe.SafePipeHandle.DangerousGetHandle(),out server) || server!=expected.Pid || connection.observation.Wait(0))
                    throw new InvalidOperationException("Connected control server is not the validated process object");
                return connection;
            } catch { connection.Dispose(); throw; }
        }
        public string Exchange(string request, int timeout) {
            if(request.Length>16384) throw new InvalidOperationException("Control request too large");
            var bytes=Encoding.UTF8.GetBytes(request+"\n");
            var write=pipe.WriteAsync(bytes,0,bytes.Length);
            if(!write.Wait(timeout)) throw new TimeoutException("Control write timed out");
            using(var data=new MemoryStream()) {
                byte[] next=new byte[1]; var deadline=DateTime.UtcNow.AddMilliseconds(timeout);
                while(data.Length<=16384) {
                    int remaining=(int)(deadline-DateTime.UtcNow).TotalMilliseconds;
                    if(remaining<=0) throw new TimeoutException("Control acknowledgement timed out");
                    var read=pipe.ReadAsync(next,0,1);
                    if(!read.Wait(remaining)) throw new TimeoutException("Control acknowledgement timed out");
                    if(read.Result==0) throw new EndOfStreamException("Control closed without acknowledgement");
                    if(next[0]==10) return Encoding.UTF8.GetString(data.ToArray());
                    data.WriteByte(next[0]);
                }
                throw new InvalidOperationException("Control response too large");
            }
        }
        public bool WaitForExit(int milliseconds) { return observation.Wait(milliseconds); }
        public bool JobEmpty() { return JobActiveProcesses()==0; }
        public int JobActiveProcesses() {
            IntPtr data=Marshal.AllocHGlobal(48);
            try { int returned; if(!QueryInformationJobObject(observation.Job,1,data,48,out returned)) throw new InvalidOperationException("Job completion unavailable"); return Marshal.ReadInt32(data,40); }
            finally { Marshal.FreeHGlobal(data); }
        }
        public void Dispose() { if(pipe!=null) pipe.Dispose(); if(observation!=null) observation.Dispose(); }
    }
    public static string InspectJob(string jobName) {
        IntPtr job=OpenJobObject(4|0x20000,false,jobName);
        if(job==IntPtr.Zero) throw new InvalidOperationException("Existing job cannot be inspected");
        IntPtr data=Marshal.AllocHGlobal(144), owner,group,dacl,sacl,descriptor=IntPtr.Zero,sddl=IntPtr.Zero;
        try {
            int returned; uint length;
            if(!QueryInformationJobObject(job,9,data,144,out returned) || GetSecurityInfo(job,6,7,out owner,out group,out dacl,out sacl,out descriptor)!=0 ||
                !ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor,1,7,out sddl,out length)) throw new InvalidOperationException("Job security/configuration unavailable");
            return "flags="+Marshal.ReadInt32(data,16)+" sddl="+Marshal.PtrToStringUni(sddl);
        } finally { if(sddl!=IntPtr.Zero) LocalFree(sddl); if(descriptor!=IntPtr.Zero) LocalFree(descriptor); Marshal.FreeHGlobal(data); CloseHandle(job); }
    }
}
