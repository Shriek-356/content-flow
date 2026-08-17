import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logoPath = path.join(__dirname, 'assets', 'logo-watermark.png');

const cmd = `ffmpeg -y -f lavfi -i color=c=black:s=1280x720:d=1 -i "${logoPath}" -filter_complex "[1:v]format=rgba,colorchannelmixer=aa=0.25,scale=w=150:h=-1,tile=layout=8x8[wm];[0:v][wm]overlay=0:0" test_output.mp4`;

try {
    execSync(cmd, { cwd: __dirname });
    console.log('Success test_output.mp4 generated!');
} catch (e) {
    console.error('Error:', e.stderr ? e.stderr.toString() : e.message);
}
