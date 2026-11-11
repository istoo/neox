declare module "*.css";
// Metro bundles woff2 as an asset (metro.config.cjs) and hands back its registry id.
declare module "*.woff2" {
  const asset: number;
  export default asset;
}
