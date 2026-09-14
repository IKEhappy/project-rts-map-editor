param([Parameter(Mandatory = $true)][string]$Path)

$src = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class RmLockFinder
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct RM_UNIQUE_PROCESS
    {
        public int dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct RM_PROCESS_INFO
    {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
        public int ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);

    [DllImport("rstrtmgr.dll")]
    private static extern int RmEndSession(uint pSessionHandle);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFileNames,
        uint nApplications, RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);

    [DllImport("rstrtmgr.dll")]
    private static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo,
        [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

    private static uint dummyReasons;

    public static List<string> WhoLocks(string path)
    {
        var result = new List<string>();
        uint handle;
        if (RmStartSession(out handle, 0, Guid.NewGuid().ToString()) != 0)
        {
            result.Add("RmStartSession failed");
            return result;
        }
        try
        {
            string[] resources = new string[] { path };
            if (RmRegisterResources(handle, 1, resources, 0, null, 0, null) != 0)
            {
                result.Add("RmRegisterResources failed");
                return result;
            }
            uint needed = 0;
            uint count = 16;
            var info = new RM_PROCESS_INFO[count];
            int res = RmGetList(handle, out needed, ref count, info, ref dummyReasons);
            if (res == 234) // ERROR_MORE_DATA
            {
                info = new RM_PROCESS_INFO[needed];
                count = needed;
                res = RmGetList(handle, out needed, ref count, info, ref dummyReasons);
            }
            if (res != 0)
            {
                result.Add("RmGetList failed: " + res);
                return result;
            }
            for (int i = 0; i < count; i++)
            {
                result.Add(info[i].Process.dwProcessId + "|" + info[i].strAppName);
            }
        }
        finally
        {
            RmEndSession(handle);
        }
        return result;
    }
}
"@

Add-Type -TypeDefinition $src
$lockers = [RmLockFinder]::WhoLocks($Path)
if ($lockers.Count -eq 0) {
    Write-Output "NO_LOCKER_FOUND (Restart Manager sees no holder)"
} else {
    foreach ($entry in $lockers) {
        $parts = $entry -split '\|', 2
        $procId = $parts[0]
        $appName = $parts[1]
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
        $cmd = ""
        if ($proc -and $proc.CommandLine) { $cmd = ($proc.CommandLine -replace '\s+', ' ') }
        if ($cmd.Length -gt 160) { $cmd = $cmd.Substring(0, 160) }
        Write-Output ("LOCKER pid={0} app={1} exe={2} cmdline={3}" -f $procId, $appName, $proc.ExecutablePath, $cmd)
    }
}
