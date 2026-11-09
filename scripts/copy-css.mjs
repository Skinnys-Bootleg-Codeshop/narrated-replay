import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
const player = readFileSync('node_modules/rrweb-player/dist/style.css', 'utf8');
writeFileSync('dist/viewer.css', `${player}\n${readFileSync('src/viewer/viewer.css', 'utf8')}`);
copyFileSync('src/react/talk-button.css', 'dist/talk-button.css');
