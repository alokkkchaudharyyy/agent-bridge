import json
import os
import sys
import zipfile
from xml.sax.saxutils import escape

def xml_esc(val):
    return escape(str(val) if val is not None else '', {'"': '&quot;'})

def main():
    here = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.dirname(here)
    pkg_path = os.path.join(repo_root, 'package.json')

    with open(pkg_path, 'r', encoding='utf-8') as f:
        pkg = json.load(f)

    name = pkg.get('name', '')
    version = pkg.get('version', '')
    publisher = pkg.get('publisher', '')
    display_name = pkg.get('displayName', '')
    description = pkg.get('description', '')
    keywords = pkg.get('keywords', [])
    categories = pkg.get('categories', [])
    engines_vscode = pkg.get('engines', {}).get('vscode', '')
    repository_url = pkg.get('repository', {}).get('url', '')
    bugs_url = pkg.get('bugs', {}).get('url', '')
    homepage = pkg.get('homepage', '')
    icon = pkg.get('icon', '')

    tags = ','.join(keywords) if isinstance(keywords, list) else str(keywords)
    cats = ','.join(categories) if isinstance(categories, list) else str(categories)

    license_file = os.path.join(repo_root, 'LICENSE')
    license_exists = os.path.isfile(license_file)

    icon_file = os.path.join(repo_root, icon) if icon else ''
    icon_exists = bool(icon and os.path.isfile(icon_file))

    readme_file = os.path.join(repo_root, 'README.md')
    readme_exists = os.path.isfile(readme_file)

    changelog_file = os.path.join(repo_root, 'CHANGELOG.md')
    changelog_exists = os.path.isfile(changelog_file)

    license_tag = '    <License>extension/LICENSE.txt</License>\n' if license_exists else ''
    icon_tag = f'    <Icon>extension/{xml_esc(icon.replace(os.sep, "/"))}</Icon>\n' if icon_exists else ''

    assets_list = [
        '    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>'
    ]
    if readme_exists:
        assets_list.append('    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>')
    if changelog_exists:
        assets_list.append('    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true"/>')
    if license_exists:
        assets_list.append('    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true"/>')
    if icon_exists:
        icon_path_norm = icon.replace(os.sep, '/')
        assets_list.append(f'    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/{xml_esc(icon_path_norm)}" Addressable="true"/>')

    assets_str = '\n'.join(assets_list)

    manifest = f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{xml_esc(name)}" Version="{xml_esc(version)}" Publisher="{xml_esc(publisher)}"/>
    <DisplayName>{xml_esc(display_name)}</DisplayName>
    <Description xml:space="preserve">{xml_esc(description)}</Description>
    <Tags>{xml_esc(tags)}</Tags>
    <Categories>{xml_esc(cats)}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{xml_esc(engines_vscode)}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/>
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="{xml_esc(repository_url)}"/>
      <Property Id="Microsoft.VisualStudio.Services.Links.Getstarted" Value="{xml_esc(repository_url)}"/>
      <Property Id="Microsoft.VisualStudio.Services.Links.Repository" Value="{xml_esc(repository_url)}"/>
      <Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="{xml_esc(bugs_url)}"/>
      <Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="{xml_esc(homepage)}"/>
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true"/>
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free"/>
    </Properties>
{license_tag}{icon_tag}  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
{assets_str}
  </Assets>
</PackageManifest>"""

    ctypes = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".png" ContentType="image/png"/>
  <Default Extension=".txt" ContentType="text/plain"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>"""

    out_name = f"{name}-{version}.vsix"
    out_path = os.path.join(repo_root, out_name)

    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', ctypes)
        z.writestr('extension.vsixmanifest', manifest)
        z.write(pkg_path, 'extension/package.json')

        src_dir = os.path.join(repo_root, 'src')
        if os.path.isdir(src_dir):
            for entry in sorted(os.listdir(src_dir)):
                full_path = os.path.join(src_dir, entry)
                if entry.endswith('.js') and os.path.isfile(full_path):
                    z.write(full_path, f"extension/src/{entry}")

        if icon_exists:
            icon_zip_path = 'extension/' + icon.replace(os.sep, '/').lstrip('/')
            z.write(icon_file, icon_zip_path)

        if readme_exists:
            z.write(readme_file, 'extension/README.md')

        if changelog_exists:
            z.write(changelog_file, 'extension/CHANGELOG.md')

        if license_exists:
            z.write(license_file, 'extension/LICENSE.txt')

    print(out_path)
    with zipfile.ZipFile(out_path, 'r') as z:
        for item in z.namelist():
            print(f"  {item}")

if __name__ == '__main__':
    main()
