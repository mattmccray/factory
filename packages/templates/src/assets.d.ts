// Template sources are Markdown files imported as text (`with { type: 'text' }`), so the package
// carries them without any file I/O at render time.
declare module '*.md' {
  const text: string;
  export default text;
}
