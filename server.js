/**
 * Express 后端服务器 - 提供文件列表 API
 * 用于扫描 frames 文件夹下的 JSON 文件
 */

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file
function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const envVars = {};
        envContent.split('\n').forEach(line => {
            line = line.trim();
            if (line && !line.startsWith('#')) {
                const [key, ...valueParts] = line.split('=');
                if (key && valueParts.length > 0) {
                    envVars[key.trim()] = valueParts.join('=').trim();
                }
            }
        });
        return envVars;
    }
    return {};
}

const env = loadEnv();
const PORT = parseInt(env.BACKEND_PORT || process.env.BACKEND_PORT || '3002', 10);

const app = express();

// 启用 CORS
app.use(cors());
// 解析 JSON body
app.use(express.json());

/**
 * 自然排序函数 - 处理 frame_1, frame_2, frame_10 这样的文件名
 */
function naturalSort(files) {
    return files.sort((a, b) => {
        const aNum = a.match(/\d+/)?.[0];
        const bNum = b.match(/\d+/)?.[0];
        
        if (aNum && bNum) {
            return parseInt(aNum) - parseInt(bNum);
        }
        
        return a.localeCompare(b);
    });
}

/**
 * API 端点：列出指定文件夹中的 JSON 文件
 * 使用: GET /api/list-json-files?folder=./frames
 */
app.get('/api/list-json-files', (req, res) => {
    try {
        const folderPath = req.query.folder || './frames';
        
        // 解析相对路径 - 相对于项目根目录
        const absolutePath = path.resolve(__dirname, folderPath);
        
        // 安全检查 - 确保路径在允许的目录中
        const realPath = fs.realpathSync(absolutePath);
        const baseDir = fs.realpathSync(__dirname);
        
        if (!realPath.startsWith(baseDir)) {
            return res.status(403).json({ 
                error: 'Access denied',
                count: 0,
                files: []
            });
        }
        
        // 检查文件夹是否存在
        if (!fs.existsSync(realPath) || !fs.statSync(realPath).isDirectory()) {
            return res.status(404).json({ 
                error: 'Folder not found',
                count: 0,
                files: []
            });
        }
        
        // 列出文件夹中的所有文件
        const allFiles = fs.readdirSync(realPath);
        
        // 过滤 JSON 文件
        const jsonFiles = allFiles.filter(file => {
            // 只选择 .json 文件
            return file.endsWith('.json');
        });
        
        // 自然排序
        const sortedFiles = naturalSort(jsonFiles);
        
        // 返回结果
        res.json({
            count: sortedFiles.length,
            files: sortedFiles,
            folder: folderPath
        });
        
    } catch (error) {
        console.error('Error listing files:', error);
        res.status(500).json({ 
            error: error.message,
            count: 0,
            files: []
        });
    }
});

/**
 * API 端点：读取帧文件
 * 使用: GET /api/read-frame-file?file=./frames/frame_robot.json
 */
app.get('/api/read-frame-file', (req, res) => {
    try {
        const filePath = req.query.file || '';
        
        if (!filePath) {
            return res.status(400).json({ 
                error: 'File path is required',
                frames: []
            });
        }
        
        // 解析相对路径 - 相对于项目根目录
        const absolutePath = path.resolve(__dirname, filePath);
        
        // 安全检查 - 确保路径在允许的目录中
        const realPath = fs.realpathSync(absolutePath);
        const baseDir = fs.realpathSync(__dirname);
        
        if (!realPath.startsWith(baseDir)) {
            return res.status(403).json({ 
                error: 'Access denied',
                frames: []
            });
        }
        
        // 检查文件是否存在
        if (!fs.existsSync(realPath) || !fs.statSync(realPath).isFile()) {
            return res.json({ 
                frames: [],
                message: 'File not found, will create new file'
            });
        }
        
        // 读取文件内容
        const fileContent = fs.readFileSync(realPath, 'utf8');
        const data = JSON.parse(fileContent);
        
        // 确保 frames 数组存在并按时间排序
        if (!data.frames || !Array.isArray(data.frames)) {
            return res.json({ 
                frames: [],
                message: 'Invalid file format'
            });
        }
        
        // 按 frame_time 排序
        data.frames.sort((a, b) => (a.frame_time || 0) - (b.frame_time || 0));
        
        res.json({
            frames: data.frames,
            count: data.frames.length
        });
        
    } catch (error) {
        console.error('Error reading frame file:', error);
        res.status(500).json({ 
            error: error.message,
            frames: []
        });
    }
});

/**
 * API 端点：保存帧文件
 * 使用: POST /api/save-frame-file
 * Body: { file: './frames/frame_robot.json', frame: {...}, frameTime: 1.5 }
 */
app.post('/api/save-frame-file', (req, res) => {
    try {
        const { file, frame, frameTime } = req.body;
        
        if (!file || !frame || frameTime === undefined) {
            return res.status(400).json({ 
                error: 'File path, frame data, and frameTime are required'
            });
        }
        
        // 解析相对路径 - 相对于项目根目录
        const absolutePath = path.resolve(__dirname, file);
        
        // 安全检查 - 确保路径在允许的目录中
        const realPath = fs.realpathSync(path.dirname(absolutePath));
        const baseDir = fs.realpathSync(__dirname);
        
        if (!realPath.startsWith(baseDir)) {
            return res.status(403).json({ 
                error: 'Access denied'
            });
        }
        
        // 确保目录存在
        const dirPath = path.dirname(absolutePath);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
        
        // 读取现有文件（如果存在）
        let frames = [];
        if (fs.existsSync(absolutePath)) {
            try {
                const fileContent = fs.readFileSync(absolutePath, 'utf8');
                const data = JSON.parse(fileContent);
                if (data.frames && Array.isArray(data.frames)) {
                    frames = data.frames;
                }
            } catch (e) {
                // 如果文件格式错误，创建新文件
                console.warn('Invalid file format, creating new file:', e.message);
            }
        }
        
        // 查找是否已存在相同时间的帧
        const existingIndex = frames.findIndex(f => Math.abs((f.frame_time || 0) - frameTime) < 0.0001);
        
        if (existingIndex >= 0) {
            // 更新现有帧
            frames[existingIndex] = frame;
        } else {
            // 添加新帧
            frames.push(frame);
        }
        
        // 按 frame_time 排序
        frames.sort((a, b) => (a.frame_time || 0) - (b.frame_time || 0));
        
        // 保存文件
        const dataToSave = { frames };
        fs.writeFileSync(absolutePath, JSON.stringify(dataToSave, null, 2), 'utf8');
        
        res.json({
            success: true,
            count: frames.length,
            message: existingIndex >= 0 ? 'Frame updated' : 'Frame added'
        });
        
    } catch (error) {
        console.error('Error saving frame file:', error);
        res.status(500).json({ 
            error: error.message
        });
    }
});

/**
 * API 端点：保存 CSV 文件
 * 使用: POST /api/save-csv-file
 * Body: { file: './frames/lafan/robot.csv', content: 'csv content...' }
 */
app.post('/api/save-csv-file', (req, res) => {
    try {
        const { file, content } = req.body;
        
        if (!file || content === undefined) {
            return res.status(400).json({ 
                error: 'File path and content are required'
            });
        }
        
        // 解析相对路径 - 相对于项目根目录
        const absolutePath = path.resolve(__dirname, file);
        
        // 安全检查 - 确保路径在允许的目录中
        const realPath = fs.realpathSync(path.dirname(absolutePath));
        const baseDir = fs.realpathSync(__dirname);
        
        if (!realPath.startsWith(baseDir)) {
            return res.status(403).json({ 
                error: 'Access denied'
            });
        }
        
        // 确保目录存在
        const dirPath = path.dirname(absolutePath);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
        
        // 保存文件
        fs.writeFileSync(absolutePath, content, 'utf8');
        
        res.json({
            success: true,
            file: file,
            message: 'CSV file saved successfully'
        });
        
    } catch (error) {
        console.error('Error saving CSV file:', error);
        res.status(500).json({ 
            error: error.message
        });
    }
});

/**
 * API 端点：应用偏移量到文件中的所有帧
 * 使用: POST /api/apply-offset
 * Body: { file: './frames/frame_robot.json', offset: { x: 0.1, y: 0.2, z: 0.3 } }
 */
app.post('/api/apply-offset', (req, res) => {
    try {
        const { file, offset } = req.body;
        
        if (!file || !offset) {
            return res.status(400).json({ 
                error: 'File path and offset are required'
            });
        }

        if (typeof offset.x !== 'number' || typeof offset.y !== 'number' || typeof offset.z !== 'number') {
            return res.status(400).json({ 
                error: 'Offset must have numeric x, y, z values'
            });
        }
        
        // 解析相对路径 - 相对于项目根目录
        const absolutePath = path.resolve(__dirname, file);
        
        // 安全检查 - 确保路径在允许的目录中
        const realPath = fs.realpathSync(path.dirname(absolutePath));
        const baseDir = fs.realpathSync(__dirname);
        
        if (!realPath.startsWith(baseDir)) {
            return res.status(403).json({ 
                error: 'Access denied'
            });
        }
        
        // 检查文件是否存在
        if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
            return res.status(404).json({ 
                error: 'File not found'
            });
        }
        
        // 读取文件内容
        const fileContent = fs.readFileSync(absolutePath, 'utf8');
        const data = JSON.parse(fileContent);
        
        // 确保 frames 数组存在
        if (!data.frames || !Array.isArray(data.frames)) {
            return res.status(400).json({ 
                error: 'Invalid file format: expected frames array'
            });
        }
        
        if (data.frames.length === 0) {
            return res.status(400).json({ 
                error: 'No frames found in file'
            });
        }
        
        // 应用偏移量到所有帧
        const updatedFrames = data.frames.map(frame => {
            const updatedFrame = JSON.parse(JSON.stringify(frame));
            
            // Ensure pos_world exists
            if (!updatedFrame.pos_world) {
                updatedFrame.pos_world = { x: 0, y: 0, z: 0 };
            }
            
            // Apply offset to position
            const originalX = updatedFrame.pos_world.x ?? 0;
            const originalY = updatedFrame.pos_world.y ?? 0;
            const originalZ = updatedFrame.pos_world.z ?? 0;
            
            updatedFrame.pos_world.x = originalX + offset.x;
            updatedFrame.pos_world.y = originalY + offset.y;
            updatedFrame.pos_world.z = originalZ + offset.z;
            
            return updatedFrame;
        });
        
        // 按 frame_time 排序
        updatedFrames.sort((a, b) => (a.frame_time || 0) - (b.frame_time || 0));
        
        // 保存文件
        const dataToSave = { frames: updatedFrames };
        fs.writeFileSync(absolutePath, JSON.stringify(dataToSave, null, 2), 'utf8');
        
        res.json({
            success: true,
            count: updatedFrames.length,
            message: 'Offset applied successfully'
        });
        
    } catch (error) {
        console.error('Error applying offset:', error);
        res.status(500).json({ 
            error: error.message
        });
    }
});

/**
 * 配置端点 - 返回前端需要的配置信息
 */
app.get('/api/config', (req, res) => {
    res.json({
        backendPort: PORT,
        backendUrl: `http://localhost:${PORT}`
    });
});

/**
 * 健康检查端点
 */
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

/**
 * 启动服务器
 */
app.listen(PORT, () => {
    console.log(`✓ Backend server running at http://localhost:${PORT}`);
    console.log(`✓ File listing API: http://localhost:${PORT}/api/list-json-files?folder=./frames`);
    console.log(`✓ Read frame file API: http://localhost:${PORT}/api/read-frame-file?file=./frames/frame_robot.json`);
    console.log(`✓ Save frame file API: POST http://localhost:${PORT}/api/save-frame-file`);
    console.log(`✓ Save CSV file API: POST http://localhost:${PORT}/api/save-csv-file`);
});
