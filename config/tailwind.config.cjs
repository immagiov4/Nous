module.exports = {
  content: [
    './apps/web/index.html',
    './apps/web/*.{js,ts,jsx,tsx}',
    './apps/web/{app,components,constants,hooks,i18n,services,utils}/**/*.{js,ts,jsx,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        paper: {
          light: '#FDFBF7',
          dark: '#252526',
          surface: '#2f3031',
        },
      },
    },
  },
};
