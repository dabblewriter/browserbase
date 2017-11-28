import babel from 'rollup-plugin-babel';

export default {
  input: 'src/index.js',
  output: {
    format: 'cjs',
    file: 'dist/index.js'
  },
  sourcemap: true,
  plugins: [
    babel({
      exclude: 'node_modules/**' // only transpile our source code
    })
  ],
  onwarn: warning => {
    if (/external dependency/.test(warning.message)) return;
    console.warn(warning.message);
  }
};
