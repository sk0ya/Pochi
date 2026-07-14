using System.IO;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace Pochi.Desktop;

public partial class MainWindow : Window
{
    // The published GitHub Pages build (see .github/workflows/deploy-pages.yml). Loaded by
    // default so the desktop shell needs no local frontend build — the WebView2 bridge is
    // injected regardless of origin, so the file dialogs etc. work the same from here.
    private const string PublishedUrl = "https://sk0ya.github.io/Pochi/";

    public MainWindow()
    {
        InitializeComponent();
        Loaded += async (_, _) => await InitWebViewAsync();
    }

    private async Task InitWebViewAsync()
    {
        var userData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Pochi");
        var env = await CoreWebView2Environment.CreateAsync(userDataFolder: userData);
        await Web.EnsureCoreWebView2Async(env);

        Web.CoreWebView2.WebMessageReceived += OnWebMessage;

        // Frontend source, in priority order:
        //   POCHI_DEV_URL   → local Vite dev server (HMR) — for working on the frontend
        //   POCHI_LOCAL=1   → the bundled local build (offline / testing unpushed changes;
        //                     needs a prior `npm run build` — see BundleFrontend in the csproj)
        //   default         → the published GitHub Pages build, so no local build is required
        var devUrl = Environment.GetEnvironmentVariable("POCHI_DEV_URL");
        if (!string.IsNullOrEmpty(devUrl))
        {
            Web.CoreWebView2.Navigate(devUrl);
            return;
        }

        if (Environment.GetEnvironmentVariable("POCHI_LOCAL") == "1")
        {
            NavigateLocalOrError();
            return;
        }

        // Fall back to a bundled build if the published site can't be reached (offline).
        void OnNav(object? _, CoreWebView2NavigationCompletedEventArgs e)
        {
            Web.CoreWebView2.NavigationCompleted -= OnNav; // only the initial load matters
            if (!e.IsSuccess) NavigateLocalOrError();
        }
        Web.CoreWebView2.NavigationCompleted += OnNav;
        Web.CoreWebView2.Navigate(PublishedUrl);
    }

    /// Navigate to the locally bundled/built frontend, or show a help page if none is present.
    private void NavigateLocalOrError()
    {
        var dist = FindDist();
        if (dist is null)
        {
            Web.CoreWebView2.NavigateToString(
                "<html><body style='background:#12151a;color:#dbe2ee;font-family:sans-serif'>" +
                "<h2>No local build found</h2><p>Connect to the internet to load the published build, " +
                "or run <code>npm run build</code> in the app folder for an offline copy.</p></body></html>");
            return;
        }

        Web.CoreWebView2.SetVirtualHostNameToFolderMapping(
            "app.pochi", dist, CoreWebView2HostResourceAccessKind.Allow);
        Web.CoreWebView2.Navigate("https://app.pochi/index.html");
    }

    private static string? FindDist()
    {
        var wwwroot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
        if (File.Exists(Path.Combine(wwwroot, "index.html"))) return wwwroot;

        // Dev fallback: walk up from bin\... to the repo root and use app\dist.
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var cand = Path.Combine(dir.FullName, "app", "dist");
            if (File.Exists(Path.Combine(cand, "index.html"))) return cand;
        }
        return null;
    }

    private static string FilterFor(string? kind) => kind switch
    {
        "svg" => "SVG image (*.svg)|*.svg|All files (*.*)|*.*",
        "excalidraw" => "Excalidraw (*.excalidraw)|*.excalidraw|All files (*.*)|*.*",
        "image" => "Image (*.png;*.jpg;*.jpeg;*.gif;*.bmp;*.webp)|*.png;*.jpg;*.jpeg;*.gif;*.bmp;*.webp|All files (*.*)|*.*",
        _ => "Pochi diagram (*.pochi.json)|*.pochi.json|JSON (*.json)|*.json|All files (*.*)|*.*",
    };

    private static string MimeFor(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".bmp" => "image/bmp",
        ".webp" => "image/webp",
        _ => "application/octet-stream",
    };

    // Extensions the file-manager panel lists and treats as diagrams (see listFiles below).
    private static readonly string[] DiagramExtensions = { ".pochi.json", ".json", ".excalidraw" };

    /** Splits a filename into (stem, extension), recognizing the compound ".pochi.json"
     *  suffix so uniquifying "foo.pochi.json" yields "foo (2).pochi.json", not "foo.pochi (2).json". */
    private static (string Stem, string Ext) SplitName(string fileName)
    {
        if (fileName.EndsWith(".pochi.json", StringComparison.OrdinalIgnoreCase))
            return (fileName[..^".pochi.json".Length], ".pochi.json");
        var ext = Path.GetExtension(fileName);
        return (fileName[..^ext.Length], ext);
    }

    /** Returns a path in `dir` for `fileName` that doesn't collide, appending " (2)", " (3)", … */
    private static string UniquePath(string dir, string fileName)
    {
        var path = Path.Combine(dir, fileName);
        if (!File.Exists(path)) return path;
        var (stem, ext) = SplitName(fileName);
        for (var i = 2; ; i++)
        {
            var cand = Path.Combine(dir, $"{stem} ({i}){ext}");
            if (!File.Exists(cand)) return cand;
        }
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        int id = 0;
        object? result = null;
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            id = root.GetProperty("id").GetInt32();
            var op = root.GetProperty("op").GetString();

            switch (op)
            {
                case "saveFileDialog":
                {
                    var dlg = new SaveFileDialog
                    {
                        FileName = root.GetProperty("suggestedName").GetString() ?? "diagram",
                        Filter = FilterFor(root.GetProperty("kind").GetString()),
                    };
                    if (dlg.ShowDialog(this) == true)
                    {
                        File.WriteAllText(dlg.FileName, root.GetProperty("content").GetString() ?? "");
                        result = dlg.FileName;
                    }
                    break;
                }
                case "writeFile":
                {
                    var path = root.GetProperty("path").GetString();
                    if (!string.IsNullOrEmpty(path))
                    {
                        File.WriteAllText(path, root.GetProperty("content").GetString() ?? "");
                        result = true;
                    }
                    break;
                }
                case "openFileDialog":
                {
                    var dlg = new OpenFileDialog
                    {
                        Filter = FilterFor(root.GetProperty("kind").GetString()),
                    };
                    if (dlg.ShowDialog(this) == true)
                    {
                        result = new { name = dlg.FileName, content = File.ReadAllText(dlg.FileName) };
                    }
                    break;
                }
                case "readFile":
                {
                    var path = root.GetProperty("path").GetString();
                    if (!string.IsNullOrEmpty(path) && File.Exists(path))
                    {
                        result = new { name = path, content = File.ReadAllText(path) };
                    }
                    break;
                }
                case "openImageDialog":
                {
                    var dlg = new OpenFileDialog
                    {
                        Filter = FilterFor("image"),
                    };
                    if (dlg.ShowDialog(this) == true)
                    {
                        var bytes = File.ReadAllBytes(dlg.FileName);
                        var dataUrl = $"data:{MimeFor(dlg.FileName)};base64,{Convert.ToBase64String(bytes)}";
                        result = new { name = dlg.FileName, dataUrl };
                    }
                    break;
                }
                case "pickFolder":
                {
                    var dlg = new OpenFolderDialog();
                    var initial = root.TryGetProperty("dir", out var d) ? d.GetString() : null;
                    if (!string.IsNullOrEmpty(initial) && Directory.Exists(initial))
                        dlg.InitialDirectory = initial;
                    if (dlg.ShowDialog(this) == true) result = dlg.FolderName;
                    break;
                }
                case "listFiles":
                {
                    // Enumerate the folder's diagram files (name + full path), newest first.
                    // Returns null if the folder is gone so the panel can self-heal (drop it).
                    var dir = root.GetProperty("dir").GetString();
                    if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir))
                    {
                        var files = new DirectoryInfo(dir)
                            .EnumerateFiles()
                            .Where(f => DiagramExtensions.Any(
                                ext => f.Name.EndsWith(ext, StringComparison.OrdinalIgnoreCase)))
                            .OrderByDescending(f => f.LastWriteTimeUtc)
                            .Select(f => new { name = f.Name, path = f.FullName })
                            .ToArray();
                        result = new { dir, files };
                    }
                    break;
                }
                case "newFile":
                {
                    // Create a fresh file in `dir`, uniquifying the name so an existing file is
                    // never clobbered. Returns the created path (its name may differ from asked).
                    var dir = root.GetProperty("dir").GetString();
                    var name = root.GetProperty("name").GetString();
                    if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir) && !string.IsNullOrEmpty(name))
                    {
                        var path = UniquePath(dir, name);
                        File.WriteAllText(path, root.GetProperty("content").GetString() ?? "");
                        result = path;
                    }
                    break;
                }
                case "renameFile":
                {
                    // Rename within the same folder. Fails (null) if the target name is already
                    // taken, so the panel can report it instead of silently overwriting.
                    var path = root.GetProperty("path").GetString();
                    var name = root.GetProperty("name").GetString();
                    if (!string.IsNullOrEmpty(path) && File.Exists(path) && !string.IsNullOrEmpty(name))
                    {
                        var dest = Path.Combine(Path.GetDirectoryName(path)!, name);
                        if (!string.Equals(dest, path, StringComparison.OrdinalIgnoreCase) && File.Exists(dest))
                        {
                            result = new { error = "exists" };
                        }
                        else
                        {
                            File.Move(path, dest, overwrite: false);
                            result = dest;
                        }
                    }
                    break;
                }
                case "duplicateFile":
                {
                    var path = root.GetProperty("path").GetString();
                    if (!string.IsNullOrEmpty(path) && File.Exists(path))
                    {
                        var dir = Path.GetDirectoryName(path)!;
                        var (stem, ext) = SplitName(Path.GetFileName(path));
                        var dest = UniquePath(dir, $"{stem} copy{ext}");
                        File.Copy(path, dest);
                        result = dest;
                    }
                    break;
                }
                case "deleteFile":
                {
                    // Plain delete; the panel confirms with the user before calling this.
                    var path = root.GetProperty("path").GetString();
                    if (!string.IsNullOrEmpty(path) && File.Exists(path))
                    {
                        File.Delete(path);
                        result = true;
                    }
                    break;
                }
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"bridge error: {ex}");
        }

        Web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { id, result }));
    }
}
