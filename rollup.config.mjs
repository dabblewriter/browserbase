export default {
  input: 'src/index.js',
  output: {
    format: 'cjs',
    file: 'dist/index.js',
    sourcemap: true,
  },
  onwarn: warning => {
    if (/external dependency/.test(warning.message)) return;
    console.warn(warning.message);
  }
};
