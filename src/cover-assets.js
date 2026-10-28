const assets = new Map();

export function setCoverAssets(manifest) {
  assets.clear();
  for (const [appId, asset] of Object.entries(manifest ?? {})) {
    if (!/^\d{1,10}$/.test(appId) || !asset || !['small', 'large'].every((key) =>
      typeof asset[key] === 'string' && /^\d+-[a-f0-9]+-(320|460)\.webp$/.test(asset[key]))) continue;
    const validPalette = ['primary', 'secondary', 'highlight'].every((key) =>
      Array.isArray(asset.palette?.[key]) && asset.palette[key].length === 3
      && asset.palette[key].every((value) => Number.isInteger(value) && value >= 0 && value <= 255));
    assets.set(appId, { ...asset, palette: validPalette ? asset.palette : undefined });
  }
}

export function getCoverAsset(appId) {
  return assets.get(String(appId));
}

export async function loadCoverAssets() {
  const response = await fetch('./assets/covers/manifest.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Cover manifest: HTTP ${response.status}`);
  setCoverAssets(await response.json());
}
