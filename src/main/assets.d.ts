// electron-vite copies files imported with ?asset next to the built main process and gives back their path.
declare module '*?asset' {
  const path: string
  export default path
}
