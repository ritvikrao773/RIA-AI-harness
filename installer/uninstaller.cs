// Ria uninstaller for Windows.
//   - removes %USERPROFILE%\.ria\bin from the user PATH (honours RIA_HOME)
//   - deletes the installed ria.exe / uninstaller.exe
//   - deletes the HKCU Uninstall entry
//   - asks before deleting config.json and saved sessions (kept by default)
//   - broadcasts WM_SETTINGCHANGE so open terminals update
//
// Flags: -y / --yes  skip the confirmation prompt (files still kept unless
//        --purge is given too; --purge also deletes config + sessions).
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32;

class Uninstaller
{
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    static extern IntPtr SendMessageTimeout(IntPtr hWnd, int Msg, IntPtr wParam, string lParam,
        int fuFlags, int uTimeout, out IntPtr lpdwResult);

    const int HWND_BROADCAST = 0xffff;
    const int WM_SETTINGCHANGE = 0x001a;
    const int SMTO_ABORTIFHUNG = 0x0002;

    static int Main(string[] args)
    {
        bool yes = false, purge = false;
        foreach (string a in args)
        {
            string s = a.ToLowerInvariant();
            if (s == "-y" || s == "--yes") yes = true;
            if (s == "--purge") { purge = true; yes = true; }
        }

        string home = Environment.GetEnvironmentVariable("RIA_HOME");
        if (string.IsNullOrEmpty(home))
            home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string riaDir = Path.Combine(home, ".ria");
        string binDir = Path.Combine(riaDir, "bin");

        Console.WriteLine("Ria uninstaller " + RiaVersion.Text);
        Console.WriteLine("  install dir:  " + riaDir);
        Console.WriteLine();

        if (!yes)
        {
            Console.Write("Remove Ria from this computer? [y/N] ");
            string answer = null;
            try { answer = Console.ReadLine(); } catch { }
            if (string.IsNullOrEmpty(answer) ||
                !(answer.Trim().ToLowerInvariant().StartsWith("y")))
            {
                Console.WriteLine("Cancelled — nothing was changed.");
                Pause();
                return 0;
            }
        }

        try
        {
            // ---- user PATH ------------------------------------------------
            RemoveFromUserPath(binDir);

            // ---- uninstall entry ------------------------------------------
            Registry.CurrentUser.DeleteSubKeyTree(
                @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Ria", false);
            Console.WriteLine("  uninstalled entry  removed (Apps & features)");

            // ---- files ------------------------------------------------------
            foreach (string f in new string[] { "ria.exe", "uninstaller.exe" })
            {
                string p = Path.Combine(binDir, f);
                if (File.Exists(p)) DeleteWithRetry(p);
            }
            if (Directory.Exists(binDir) && !Directory.EnumerateFileSystemEntries(binDir).GetEnumerator().MoveNext())
                Directory.Delete(binDir);

            if (purge)
            {
                DeleteSessionsAndConfig(riaDir);
            }
            else
            {
                // Everything that holds user data: keep unless explicitly confirmed.
                Console.WriteLine();
                Console.Write("Also delete config.json and saved sessions in " + riaDir + "? [y/N] ");
                string answer = null;
                try { answer = Console.ReadLine(); } catch { }
                if (!string.IsNullOrEmpty(answer) && answer.Trim().ToLowerInvariant().StartsWith("y"))
                    DeleteSessionsAndConfig(riaDir);
                else
                    Console.WriteLine("  kept  " + riaDir + " (config + sessions) — delete the folder manually if wanted.");
            }

            BroadcastChange();
            Console.WriteLine();
            Console.WriteLine("Ria removed. Existing terminal windows keep the old PATH until restarted.");
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("error: " + e.Message);
            return 1;
        }
        Pause();
        return 0;
    }

    static void DeleteSessionsAndConfig(string riaDir)
    {
        string sessions = Path.Combine(riaDir, "sessions");
        string config = Path.Combine(riaDir, "config.json");
        if (Directory.Exists(sessions)) { Directory.Delete(sessions, true); Console.WriteLine("  deleted  " + sessions); }
        if (File.Exists(config)) { File.Delete(config); Console.WriteLine("  deleted  " + config); }
        if (Directory.Exists(riaDir) && !Directory.EnumerateFileSystemEntries(riaDir).GetEnumerator().MoveNext())
            Directory.Delete(riaDir);
    }

    static void RemoveFromUserPath(string dir)
    {
        using (RegistryKey env = Registry.CurrentUser.OpenSubKey("Environment", true))
        {
            if (env == null) return;
            string cur = env.GetValue("Path", "", RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
            if (string.IsNullOrEmpty(cur)) return;
            string[] parts = cur.Split(';');
            var kept = new System.Collections.Generic.List<string>();
            bool changed = false;
            foreach (string p in parts)
            {
                string t = Environment.ExpandEnvironmentVariables(p.Trim());
                if (t.Equals(dir, StringComparison.OrdinalIgnoreCase)) { changed = true; continue; }
                if (p.Length > 0) kept.Add(p);
            }
            if (changed)
            {
                env.SetValue("Path", string.Join(";", kept.ToArray()), RegistryValueKind.ExpandString);
                Console.WriteLine("  PATH       removed " + dir);
            }
            else
            {
                Console.WriteLine("  PATH       " + dir + " was not on the user PATH");
            }
        }
    }

    static void DeleteWithRetry(string path)
    {
        for (int i = 0; ; i++)
        {
            try { File.Delete(path); return; }
            catch (IOException)
            {
                if (i >= 5) throw;
                Console.WriteLine("  " + path + " is busy (running?) — retrying in 1s…");
                System.Threading.Thread.Sleep(1000);
            }
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
        Console.WriteLine();
        Console.Write("Press Enter to close…");
        try { Console.ReadLine(); } catch { }
    }
}
