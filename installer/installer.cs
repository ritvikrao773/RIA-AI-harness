// Ria installer for Windows.
// Expects ria.exe in the SAME folder as installer.exe (the release zip ships
// them side by side — no embedded payload, so it's a plain copy operation
// that antivirus tools don't flag as a dropper).
//
// What it does:
//   1. copies ria.exe (and uninstaller.exe when present) to %USERPROFILE%\.ria\bin
//      (honours the RIA_HOME env var for portable installs)
//   2. adds that folder to the user PATH (HKCU\Environment, REG_EXPAND_SZ)
//      and broadcasts WM_SETTINGCHANGE so new terminals see it immediately
//   3. registers an "Uninstall Ria" entry under HKCU Uninstall, pointing at
//      the uninstaller.exe it installs alongside ria.exe
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32;

class Installer
{
    const string BinSubDir = ".ria\\bin";

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    static extern IntPtr SendMessageTimeout(IntPtr hWnd, int Msg, IntPtr wParam, string lParam,
        int fuFlags, int uTimeout, out IntPtr lpdwResult);

    const int HWND_BROADCAST = 0xffff;
    const int WM_SETTINGCHANGE = 0x001a;
    const int SMTO_ABORTIFHUNG = 0x0002;

    static int Main()
    {
        try
        {
            Console.WriteLine("Ria installer");
            Console.WriteLine();

            string home = Environment.GetEnvironmentVariable("RIA_HOME");
            if (string.IsNullOrEmpty(home))
                home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string binDir = Path.Combine(home, ".ria", "bin");
            Directory.CreateDirectory(binDir);

            // ---- locate the payload -------------------------------------
            string beside = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "ria.exe");
            byte[] payload = File.Exists(beside) ? File.ReadAllBytes(beside) : null;
            if (payload == null)
            {
                Console.Error.WriteLine("error: ria.exe must sit in the same folder as installer.exe");
                return 1;
            }

            // ---- install files (retry: a running ria.exe can lock the copy)
            string dest = Path.Combine(binDir, "ria.exe");
            WriteWithRetry(dest, payload);
            Console.WriteLine("  installed  " + dest + "  (" + (payload.Length / 1024 / 1024) + " MB)");

            string uninsBeside = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "uninstaller.exe");
            if (File.Exists(uninsBeside) && !uninsBeside.Equals(Path.Combine(binDir, "uninstaller.exe"), StringComparison.OrdinalIgnoreCase))
            {
                File.Copy(uninsBeside, Path.Combine(binDir, "uninstaller.exe"), true);
                Console.WriteLine("  installed  " + Path.Combine(binDir, "uninstaller.exe"));
            }

            // ---- user PATH ------------------------------------------------
            AddToUserPath(binDir);

            // ---- uninstall entry (Apps & features) ------------------------
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Ria"))
            {
                key.SetValue("DisplayName", "Ria (AI coding agent)", RegistryValueKind.String);
                key.SetValue("DisplayVersion", RiaVersion.Text, RegistryValueKind.String);
                key.SetValue("UninstallString", Path.Combine(binDir, "uninstaller.exe"), RegistryValueKind.String);
                key.SetValue("DisplayIcon", dest, RegistryValueKind.String);
                key.SetValue("Publisher", "Ria", RegistryValueKind.String);
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }

            BroadcastChange();
            Console.WriteLine();
            Console.WriteLine("Done. Open a NEW terminal window and run:  ria --version");
            Console.WriteLine("To remove Ria later: run uninstaller.exe (in " + binDir + ") or use Apps & features.");
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("error: " + e.Message);
            return 1;
        }
        Pause();
        return 0;
    }

    static void WriteWithRetry(string dest, byte[] payload)
    {
        for (int i = 0; ; i++)
        {
            try
            {
                using (FileStream f = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    f.Write(payload, 0, payload.Length);
                }
                return;
            }
            catch (IOException)
            {
                if (i >= 5) throw;
                Console.WriteLine("  " + dest + " is busy (running?) — retrying in 1s…");
                System.Threading.Thread.Sleep(1000);
            }
        }
    }

    static void AddToUserPath(string dir)
    {
        using (RegistryKey env = Registry.CurrentUser.OpenSubKey("Environment", true))
        {
            string cur = (env.GetValue("Path", "", RegistryValueOptions.DoNotExpandEnvironmentNames) as string) ?? "";
            string[] parts = cur.Split(';');
            foreach (string p in parts)
            {
                string t = Environment.ExpandEnvironmentVariables(p.Trim());
                if (t.Equals(dir, StringComparison.OrdinalIgnoreCase) || t.Equals(Environment.ExpandEnvironmentVariables(dir), StringComparison.OrdinalIgnoreCase))
                {
                    Console.WriteLine("  PATH       already contains " + dir);
                    return;
                }
            }
            string updated = string.IsNullOrEmpty(cur) ? dir : cur.TrimEnd(';') + ";" + dir;
            env.SetValue("Path", updated, RegistryValueKind.ExpandString);
            Console.WriteLine("  PATH       added " + dir);
        }
    }

    static void BroadcastChange()
    {
        IntPtr res;
        SendMessageTimeout((IntPtr)HWND_BROADCAST, WM_SETTINGCHANGE, IntPtr.Zero, "Environment",
            SMTO_ABORTIFHUNG, 3000, out res);
    }

    static void Pause()
    {
        // Blocks only when run interactively (double-click); piped stdin returns at once.
        Console.WriteLine();
        Console.Write("Press Enter to close…");
        try { Console.ReadLine(); } catch { }
    }
}
