/**
 * unzipper (used by read-excel-file) has requires that never run in Electron: S3 archive
 * support (@aws-sdk/client-s3) and a stream polyfill for Node < 8 (readable-stream).
 * Leave them unresolved instead of bundling or failing on them. Other packages, such as
 * jszip, depend on readable-stream for real, so this only applies to unzipper.
 */
const unusedOptionalRequiresPlugin = {
  name: 'unused-optional-requires',
  setup(build) {
    build.onResolve({ filter: /^(readable-stream|@aws-sdk\/client-s3)$/ }, (args) => {
      if (/[\\/]unzipper[\\/]/.test(args.importer)) {
        return { path: args.path, external: true };
      }
      return undefined;
    });
  },
};

module.exports = { unusedOptionalRequiresPlugin };
