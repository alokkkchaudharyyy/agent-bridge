import json, os, zipfile
here = os.path.dirname(os.path.abspath(__file__))
pkg = {
    "name": "nexera-agent-bridge", "displayName": "Nexera Agent Bridge",
    "description": "Sends prompts from .agent-inbox/prompt.md to the agent side panel.",
    "publisher": "alok-local", "version": "0.0.1",
    "engines": {"vscode": "^1.80.0"},
    "activationEvents": ["onStartupFinished"], "main": "./extension.js",
}
manifest = """<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="nexera-agent-bridge" Version="0.0.1" Publisher="alok-local"/>
    <DisplayName>Nexera Agent Bridge</DisplayName>
    <Description xml:space="preserve">Sends prompts from .agent-inbox/prompt.md to the agent side panel.</Description>
    <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.80.0"/></Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>"""
ctypes = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>"""
out = os.path.join(here, "nexera-agent-bridge-0.0.1.vsix")
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", ctypes)
    z.writestr("extension.vsixmanifest", manifest)
    z.writestr("extension/package.json", json.dumps(pkg, indent=2))
    z.write(os.path.join(here, "extension.js"), "extension/extension.js")
print(out)
