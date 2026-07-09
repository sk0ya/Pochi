using System.IO;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace Pochi.Desktop;

public partial class MainWindow : Window
{
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

        // Dev server override: set POCHI_DEV_URL=http://localhost:5173 for HMR.
        var devUrl = Environment.GetEnvironmentVariable("POCHI_DEV_URL");
        if (!string.IsNullOrEmpty(devUrl))
        {
            Web.CoreWebView2.Navigate(devUrl);
            return;
        }

        var dist = FindDist();
        if (dist is null)
        {
            Web.CoreWebView2.NavigateToString(
                "<html><body style='background:#12151a;color:#dbe2ee;font-family:sans-serif'>" +
                "<h2>app/dist not found</h2><p>Run <code>npm run build</code> in the app folder first.</p></body></html>");
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
        _ => "Pochi diagram (*.pochi.json)|*.pochi.json|JSON (*.json)|*.json|All files (*.*)|*.*",
    };

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
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"bridge error: {ex}");
        }

        Web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { id, result }));
    }
}
