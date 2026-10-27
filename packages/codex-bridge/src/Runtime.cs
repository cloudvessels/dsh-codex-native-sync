using System;
using System.IO;
using System.Linq;
using System.Diagnostics;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Collections.Generic;
class Runtime {
 static string Quote(string value){var b=new System.Text.StringBuilder("\"");int slashes=0;foreach(char c in value){if(c=='\\'){slashes++;continue;}if(c=='"'){b.Append('\\',slashes*2+1);b.Append(c);}else{b.Append('\\',slashes);b.Append(c);}slashes=0;}b.Append('\\',slashes*2);b.Append('"');return b.ToString();}
 static string Args(IEnumerable<string> args){return String.Join(" ",args.Select(Quote));}
 static bool WaitForUpdate(string root){
  string file=Path.Combine(root,".updates","apply.migration.lock");var until=DateTime.UtcNow.AddSeconds(60);
  while(File.Exists(file)){
   try{var value=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(file));var p=Process.GetProcessById(Convert.ToInt32(value["pid"]));if(p.HasExited)return true;}
   catch(ArgumentException){return true;}catch{ return false; }
   if(DateTime.UtcNow>until)return false;System.Threading.Thread.Sleep(200);
  }return true;
 }
 static void StartUpdater(string root,Dictionary<string,object> spec){
  if(Environment.GetEnvironmentVariable("DSH_SYNC_DISABLE_UPDATES")=="1")return;
  try{string worker=Path.Combine(root,"suite","updater","worker.mjs");if(!File.Exists(worker))return;
   using(var child=Process.Start(new ProcessStartInfo((string)spec["node"],Args(new[]{worker,"--runtime",root})){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true})){}
  }catch{}
 }
 static async Task Pump(Stream source,Stream target){byte[] buffer=new byte[8192];int count;while((count=await source.ReadAsync(buffer,0,buffer.Length))>0){await target.WriteAsync(buffer,0,count);await target.FlushAsync();}}
 static string ResolveNative(string root){
  string hint=Path.Combine(root,"native.path");if(File.Exists(hint)){string p=File.ReadAllText(hint).Trim();if(File.Exists(p)&&!String.Equals(p,System.Reflection.Assembly.GetExecutingAssembly().Location,StringComparison.OrdinalIgnoreCase))return p;}
  string cache=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"OpenAI","Codex","bin");
  return Directory.Exists(cache)?Directory.GetDirectories(cache).Select(d=>Path.Combine(d,"codex.exe")).Where(File.Exists).OrderByDescending(File.GetLastWriteTimeUtc).FirstOrDefault():null;
 }
 static void Record(string root,string mode,string reason){try{var data=new Dictionary<string,object>{{"at",DateTime.UtcNow.ToString("o")},{"mode",mode},{"reason",reason},{"runtimeVersion","0.2.0"},{"pid",Process.GetCurrentProcess().Id}};File.WriteAllText(Path.Combine(root,"last-launch.json"),new JavaScriptSerializer().Serialize(data));}catch{}}
 static bool Ready(Dictionary<string,object> spec,string specFile,out string reason){
  reason="preflight_failed";try{
   string node=(string)spec["node"],preflight=(string)spec["preflight"];
   if(!File.Exists(node)||!File.Exists(preflight)){reason="plugin_component_missing";return false;}
   var info=new ProcessStartInfo(node,Args(new[]{preflight,specFile})){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};
   using(var p=Process.Start(info)){var stdout=p.StandardOutput.ReadToEndAsync();var stderr=p.StandardError.ReadToEndAsync();if(!p.WaitForExit(7000)){try{p.Kill();}catch{}reason="preflight_timeout";return false;}Task.WaitAll(stdout,stderr);reason=p.ExitCode==0?"ready":(p.ExitCode==3?"plugin_disabled_or_paused":"preflight_failed");return p.ExitCode==0;}
  }catch{reason="preflight_exception";return false;}
 }
 [STAThread] static int Main(string[] args){
  string root=Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location),native=ResolveNative(root);
  if(native==null){try{Console.Error.WriteLine("DSH sync: native Codex runtime was not found.");}catch{}return 1;}
  try{
   string exe=native,arguments=Args(args),reason="passthrough",mode="native";
   // Only the desktop's primary stdio launch uses this marker. CLI/browser helper servers pass through.
   bool server=args.Contains("app-server")&&args.Contains("--analytics-default-enabled")&&!args.Any(a=>new[]{"generate-ts","generate-json-schema","daemon","proxy","--help"}.Contains(a));
   string specFile=Path.Combine(root,"runtime.json");
   if(server&&File.Exists(specFile)){
    if(!WaitForUpdate(root)){Console.Error.WriteLine("DSH sync: an update is still being installed; reopen Codex shortly.");return 1;}
    try{var spec=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(specFile));
      StartUpdater(root,spec);
      if(spec.ContainsKey("home"))Environment.SetEnvironmentVariable("CODEX_HOME",(string)spec["home"]);
      if(spec.ContainsKey("config"))Environment.SetEnvironmentVariable("DSH_BRIDGE_CONFIG",(string)spec["config"]);
      if(Ready(spec,specFile,out reason)){exe=(string)spec["node"];arguments=Args(new[]{(string)spec["proxy"]}.Concat(args));mode="bridge";}}
    catch{reason="runtime_settings_invalid";}
   }
   if(server)Record(root,mode,reason);
   var info=new ProcessStartInfo(exe,arguments){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
   using(var child=Process.Start(info)){
    Task stdin=Task.Run(async()=>{try{await Pump(Console.OpenStandardInput(),child.StandardInput.BaseStream);child.StandardInput.Close();}catch{}});
    Task stdout=Pump(child.StandardOutput.BaseStream,Console.OpenStandardOutput()),stderr=Pump(child.StandardError.BaseStream,Console.OpenStandardError());
    child.WaitForExit();Task.WaitAll(stdout,stderr);return child.ExitCode;
   }
  }catch(Exception ex){try{Console.Error.WriteLine("DSH sync runtime: "+ex.Message);}catch{}return 1;}
 }
}
