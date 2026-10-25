using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Notto.WindowsMicWatcher;

public enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
public enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }
public enum AudioSessionState { Inactive = 0, Active = 1, Expired = 2 }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator
{
    int EnumAudioEndpoints(int dataFlow, int dwStateMask, out object devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice ppDevice);
    int RegisterEndpointNotificationCallback(IntPtr pClient);
    int UnregisterEndpointNotificationCallback(IntPtr pClient);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice
{
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    int OpenPropertyStore(int stgmAccess, out IntPtr ppProperties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
    int GetState(out int pdwState);
}

[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2
{
    int GetAudioSessionControl(ref Guid AudioSessionGuid, uint StreamFlags, out IAudioSessionControl SessionControl);
    int GetSimpleAudioVolume(ref Guid AudioSessionGuid, uint StreamFlags, out object SimpleAudioVolume);
    int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
    int RegisterSessionNotification(IntPtr NewNotifications);
    int UnregisterSessionNotification(IntPtr NewNotifications);
    int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionID, IntPtr duckNotification);
    int UnregisterDuckNotification(IntPtr duckNotification);
}

[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator
{
    int GetCount(out int SessionCount);
    int GetSession(int SessionCount, out IAudioSessionControl Session);
}

[ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl
{
    int GetState(out AudioSessionState pRetVal);
    int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
    int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
    int GetGroupingParam(out Guid pRetVal);
    int SetGroupingParam(ref Guid Override, ref Guid EventContext);
    int RegisterAudioSessionNotification(IntPtr NewNotifications);
    int UnregisterAudioSessionNotification(IntPtr NewNotifications);
}

[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2
{
    int GetState(out AudioSessionState pRetVal);
    int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
    int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
    int GetGroupingParam(out Guid pRetVal);
    int SetGroupingParam(ref Guid Override, ref Guid EventContext);
    int RegisterAudioSessionNotification(IntPtr NewNotifications);
    int UnregisterAudioSessionNotification(IntPtr NewNotifications);
    int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int GetProcessId(out uint pRetVal);
    int IsSystemSoundsSession();
    int SetDuckingPreference(int optOut);
}

static class Program
{
    [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr pvReserved, uint dwCoInit);
    [DllImport("ole32.dll")] static extern void CoUninitialize();

    static readonly string[] NonMeetingApps = ParseList(0);
    static readonly string[] SystemProcesses = ParseList(1);

    static int Main()
    {
        CoInitializeEx(IntPtr.Zero, 0);
        try
        {
            bool? prev = null;
            while (true)
            {
                bool cur = false;
                try { cur = IsMicActiveByExternalApp(); } catch { cur = false; }

                if (prev == null || cur != prev.Value)
                {
                    Console.WriteLine(cur ? "MIC_ACTIVE" : "MIC_INACTIVE");
                    prev = cur;
                }

                Thread.Sleep(1000);
            }
        }
        finally
        {
            CoUninitialize();
        }
    }

    static string[] ParseList(int argIndex)
    {
        if (Environment.GetCommandLineArgs().Length <= argIndex + 1) return Array.Empty<string>();
        return Environment.GetCommandLineArgs()[argIndex + 1]
            .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(item => item.ToLowerInvariant())
            .ToArray();
    }

    static bool IsSystemProcess(string name)
    {
        var lower = name.ToLowerInvariant();
        return SystemProcesses.Any(process => lower == process || lower.Contains(process, StringComparison.Ordinal));
    }

    static bool IsNonMeetingApp(string name)
    {
        var lower = name.ToLowerInvariant();
        return NonMeetingApps.Any(process => lower.Contains(process, StringComparison.Ordinal));
    }

    static bool IsMicActiveByExternalApp()
    {
        var clsid = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
        var enumeratorObj = Activator.CreateInstance(Type.GetTypeFromCLSID(clsid)!);
        var enumerator = (IMMDeviceEnumerator)enumeratorObj!;

        IMMDevice device;
        int hr = enumerator.GetDefaultAudioEndpoint((int)EDataFlow.eCapture, (int)ERole.eConsole, out device);
        if (hr != 0 || device == null)
        {
            Marshal.ReleaseComObject(enumerator);
            return false;
        }

        var iidMgr2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
        object mgrObj;
        hr = device.Activate(ref iidMgr2, 23, IntPtr.Zero, out mgrObj);
        Marshal.ReleaseComObject(device);
        if (hr != 0 || mgrObj == null)
        {
            Marshal.ReleaseComObject(enumerator);
            return false;
        }

        var mgr2 = (IAudioSessionManager2)mgrObj;
        IAudioSessionEnumerator sessionEnum;
        hr = mgr2.GetSessionEnumerator(out sessionEnum);
        if (hr != 0 || sessionEnum == null)
        {
            Marshal.ReleaseComObject(mgr2);
            Marshal.ReleaseComObject(enumerator);
            return false;
        }

        sessionEnum.GetCount(out var count);
        var foundExternalApp = false;

        for (var i = 0; i < count; i++)
        {
            IAudioSessionControl ctrl;
            if (sessionEnum.GetSession(i, out ctrl) != 0 || ctrl == null) continue;

            try
            {
                if (ctrl is not IAudioSessionControl2 ctrl2) continue;
                if (ctrl2.GetProcessId(out var pid) != 0) continue;
                if (pid == 0) continue;

                using var process = Process.GetProcessById((int)pid);
                var name = process.ProcessName;
                if (IsSystemProcess(name) || IsNonMeetingApp(name)) continue;

                ctrl.GetState(out var state);
                if (state == AudioSessionState.Active)
                {
                    foundExternalApp = true;
                    break;
                }
            }
            catch
            {
                // Process could have exited or become inaccessible between enumeration and inspection.
            }
            finally
            {
                Marshal.ReleaseComObject(ctrl);
            }
        }

        Marshal.ReleaseComObject(sessionEnum);
        Marshal.ReleaseComObject(mgr2);
        Marshal.ReleaseComObject(enumerator);
        return foundExternalApp;
    }
}
