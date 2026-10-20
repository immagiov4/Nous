module.exports = {
  plugins: {
    tailwindcss: {
      config: require('node:path').resolve(__dirname, '../../config/tailwind.config.cjs'),
    },
    autoprefixer: {},
  },
};
