/**
 * 国际化工具 - 支持中文和英文
 */

// 获取版本号（构建时会替换为实际版本号）
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0';

export const translations = {
    'zh-CN': {
        // 顶部控制栏
        'visual': '视觉',
        'collision': '碰撞',
        'com': '质心',
        'inertia': '惯量',
        'axes': '坐标轴',
        'jointAxes': '关节轴',
        'shadow': '阴影',
        'fixedGround': '固定地面',
        'lighting': '光照',
        'files': '文件',
        'joints': '关节',
        'structure': '结构',
        'edit': '编辑',
        'help': '帮助',
        'theme': '主题',
        'language': '语言',

        // 面板标题
        'fileList': '文件',
        'jointControl': '关节',
        'basePoseControl': '基座姿态',
        'modelStructure': '结构',
        'codeEditor': '编辑',

        // 关节控制
        'radian': '弧度',
        'degree': '角度',
        'reset': '重置',
        'limits': '限位',
        
        // 基座姿态控制
        'basePose': '基座',
        'orientation': '姿态（RPY）',
        'position': '位置（世界系）',
        'resetBasePose': '重置基座姿态',
        'frameTime': '帧时间 (s)',
        'saveFrame': '保存帧',
        'frameSaved': '帧已保存到 frame.json',
        'frameCopied': '帧数据已复制到剪贴板',
        'frameCopyFailed': '复制到剪贴板失败',
        'loadFramePath': '帧路径',
        'framePathPlaceholder': '输入 frame.json 路径或粘贴 JSON 数据',
        'loadFrame': '读取帧',
        'frameLoaded': '帧已成功加载',
        'framePathRequired': '请输入帧路径或 JSON 数据',
        'invalidJSON': 'JSON 格式无效',
        'frameLoadFailed': '加载帧失败',
        'invalidFrameData': '无效的帧数据',
        'frameLoadError': '加载帧时出错',
        'noModelLoaded': '未加载模型',
        'frameFolderPath': '帧文件夹',
        'frameFolderPlaceholder': '例如：./frames',
        'selectFrameFile': '选择帧文件',
        'scan': '扫描',
        'scanFolder': '扫描文件夹',
        'frameFolderRequired': '请输入文件夹路径',
        'scanFailed': '扫描失败',
        'filesFound': '找到文件',
        'scanError': '扫描文件夹出错',
        'frameSlider': '浏览帧',
        'loadFrames': '读取帧',
        'loadingFrames': '加载中...',
        'framesLoaded': '帧已加载',
        'prevFrame': '上一帧',
        'nextFrame': '下一帧',
        'interpolateFrames': '线性插值并转为lafan格式',
        'interpolateAndSave': '线性插值并转为lafan格式',
        'frequency': '频率',
        'processing': '处理中...',
        'interpolateSuccess': '成功插值 {count} 帧（{fps}Hz）并保存到 {path}',
        'interpolateError': '插值失败：{error}',
        'invalidFileFormat': '无效的文件格式：需要 frames 数组',
        'emptyFramesArray': 'JSON 文件必须包含非空的 "frames" 数组',
        'failedToLoadFile': '加载文件失败：{status}',

        // MuJoCo 仿真
        'mujocoReset': '重置',
        'mujocoSimulate': '仿真',
        'mujocoPause': '暂停',

        // 代码编辑器
        'reload': '重新加载',
        'download': '下载',
        'saved': '已保存',
        'unsaved': '未保存',
        'noFileOpen': '未打开文件',

        // 帮助对话框
        'helpTitle': `Robot Viewer v${APP_VERSION}`,
        'about': '关于',
        'aboutContent': 'Robot Viewer 是一个基于 Three.js 的网页端机器人模型 3D 查看器，提供直观的可视化界面，帮助您在浏览器中查看和分析机器人的结构、关节和物理属性，无需安装任何软件。<br><br>格式支持：URDF、MJCF、USD（部分支持）<br>机器人类型：串联机器人结构（暂不支持并联机器人）<br><br>由 <strong>范子琦</strong> 开发。',
        'projectHome': '项目主页',
        'email': '邮箱',
        'githubProfile': 'GitHub 主页',
        'operations': '操作指南',
        'leftDrag': '左键拖动',
        'rotateView': '旋转视角',
        'rightDrag': '右键拖动',
        'panView': '平移视角',
        'scroll': '滚轮',
        'zoom': '缩放视图',
        'clickModel': '点击模型',
        'controlJoint': '控制关节（可拖动）',
        'dragFile': '拖拽文件',
        'loadModel': '加载机器人模型',
        'contact': '联系方式',
        'support': '支持',

        // 其他
        'noFolder': '未加载文件夹',
        'noModel': '未加载模型',
        'noControllableJoints': '未找到可控制关节',
        'clickToEditMin': '点击编辑下限',
        'clickToEditMax': '点击编辑上限',
        'dropHint': '拖拽机器人模型文件或文件夹到页面任意位置',
        'dropHintSub': '支持 URDF, MJCF 格式<br>支持拖拽文件夹以加载mesh文件',
        'graphHint': '拖动: 移动 | 滚轮: 缩放 | 右键: 隐藏/显示 | Ctrl+左键: 测量',
        'copyright': '© 2025 范子琦 版权所有。',

        // 模型信息
        'type': '类型',
        'links': 'Links',
        'joints': '关节',
        'controllable': '可控',
        'rootLink': '根Link',

        // 悬浮信息
        'linkName': 'Link名称',
        'jointName': '关节',
        'mass': '质量',
        'mergedLinks': '合并的Links',

        // 文件类型
        'model': '模型',
        'mesh': '网格',
        'link': '链接',

        // 单位
        'kg': 'kg',
        'rad': 'rad',
        'deg': 'deg',
        'm': 'm',

        // 状态消息
        'loading': '正在加载',
        'unsupportedFormat': '不支持的文件格式',
        'loadFailed': '加载失败',
        'noSupportedFiles': '未找到支持的文件（URDF, MJCF, DAE, STL, OBJ）',
        'loadSuccess': '模型加载成功',
        'cannotLoadMesh': '无法加载 mesh 文件',

        // 编辑器消息
        'unsavedChanges': '您有未保存的更改，确定要关闭吗？',
        'newFile': '新文件.xml',
        'noFileToReload': '没有可重新加载的文件',
        'saveFirst': '请先保存为文件后再加载',
        'reloadingModel': '正在重新加载模型...',
        'modelReloaded': '模型已重新加载（未保存）',
        'reloadFailed': '重新加载失败',
        'downloadFailed': '下载失败',
        'fileDownloaded': '文件已下载',
        'emptyContent': '编辑器内容为空，无法加载',
        'fileType': '文件类型'
    },
    'en-US': {
        // Top control bar
        'visual': 'Visual',
        'collision': 'Collision',
        'com': 'COM',
        'inertia': 'Inertia',
        'axes': 'Axes',
        'jointAxes': 'Joint Axes',
        'shadow': 'Shadow',
        'fixedGround': 'Fix Ground',
        'lighting': 'Lighting',
        'files': 'Files',
        'joints': 'Joints',
        'structure': 'Structure',
        'edit': 'Edit',
        'help': 'Help',
        'theme': 'Theme',
        'language': 'Language',

        // Panel titles
        'fileList': 'Files',
        'jointControl': 'Joints',
        'basePoseControl': 'Base Pose',
        'modelStructure': 'Structure',
        'codeEditor': 'Editor',

        // Joint control
        'radian': 'Radian',
        'degree': 'Degree',
        'reset': 'Reset',
        'limits': 'Limits',
        
        // Base pose control
        'basePose': 'Base',
        'orientation': 'Orientation (RPY)',
        'position': 'Position (World)',
        'resetBasePose': 'Reset Base Pose',
        'frameTime': 'Frame Time (s)',
        'saveFrame': 'Save Frame',
        'frameSaved': 'Frame saved to frame.json',
        'frameCopied': 'Frame data copied to clipboard',
        'frameCopyFailed': 'Failed to copy to clipboard',
        'loadFramePath': 'Frame Path',
        'framePathPlaceholder': 'Enter frame.json path or paste JSON',
        'loadFrame': 'Load Frame',
        'frameLoaded': 'Frame loaded successfully',
        'framePathRequired': 'Please enter frame path or JSON data',
        'invalidJSON': 'Invalid JSON format',
        'frameLoadFailed': 'Failed to load frame',
        'invalidFrameData': 'Invalid frame data',
        'frameLoadError': 'Error loading frame',
        'noModelLoaded': 'No model loaded',
        'frameFolderPath': 'Frames Folder',
        'frameFolderPlaceholder': 'e.g., ./frames',
        'selectFrameFile': 'Select Frame File',
        'scan': 'Scan',
        'scanFolder': 'Scan Folder',
        'frameFolderRequired': 'Please enter folder path',
        'scanFailed': 'Scan failed',
        'filesFound': 'Files found',
        'scanError': 'Error scanning folder',
        'frameSlider': 'Browse Frames',
        'loadFrames': 'Load Frames',
        'loadingFrames': 'Loading...',
        'framesLoaded': 'Frames loaded',
        'prevFrame': 'Prev Frame',
        'nextFrame': 'Next Frame',
        'interpolateFrames': 'Interpolate to LaFAN Format',
        'interpolateAndSave': 'Interpolate to LaFAN Format',
        'frequency': 'Frequency',
        'processing': 'Processing...',
        'interpolateSuccess': 'Successfully interpolated {count} frames at {fps}Hz and saved to {path}',
        'interpolateError': 'Interpolation failed: {error}',
        'invalidFileFormat': 'Invalid file format: expected frames array',
        'emptyFramesArray': 'JSON file must contain a non-empty "frames" array',
        'failedToLoadFile': 'Failed to load file: {status}',

        // MuJoCo simulation
        'mujocoReset': 'Reset',
        'mujocoSimulate': 'Simulate',
        'mujocoPause': 'Pause',

        // Code editor
        'reload': 'Reload',
        'download': 'Download',
        'saved': 'Saved',
        'unsaved': 'Unsaved',
        'noFileOpen': 'No File Open',

        // Help dialog
        'helpTitle': `Robot Viewer v${APP_VERSION}`,
        'about': 'About',
        'aboutContent': 'Robot Viewer is a web-based 3D viewer for robot models and scenes. Built on top of Three.js, it provides an intuitive interface for visualizing, editing, and simulating robots directly in the browser without any installation required. This tool helps you visualize and analyze robot structures, joints, and physical properties.<br><br>Format Support: URDF, MJCF, USD (partial support)<br>Robot Types: Serial robot structures (parallel robots not currently supported)<br><br>Developed by <strong>Ziqi Fan</strong>.',
        'projectHome': 'Project Home',
        'email': 'Email',
        'githubProfile': 'GitHub Profile',
        'operations': 'Operations',
        'leftDrag': 'Left Drag',
        'rotateView': 'Rotate View',
        'rightDrag': 'Right Drag',
        'panView': 'Pan View',
        'scroll': 'Scroll',
        'zoom': 'Zoom',
        'clickModel': 'Click Model',
        'controlJoint': 'Control Joint (Draggable)',
        'dragFile': 'Drag File',
        'loadModel': 'Load Robot Model',
        'contact': 'Contact',
        'support': 'Support',

        // Others
        'noFolder': 'No Folder Loaded',
        'noModel': 'No Model Loaded',
        'noControllableJoints': 'No Controllable Joints Found',
        'clickToEditMin': 'Click to edit minimum',
        'clickToEditMax': 'Click to edit maximum',
        'dropHint': 'Drag and drop robot model files or folders anywhere',
        'dropHintSub': 'Supports URDF, MJCF formats<br>Supports folder dragging to load mesh files',
        'graphHint': 'Drag: Move | Scroll: Zoom | Right-click: Hide/Show | Ctrl+Click: Measure',
        'copyright': '© 2025 Ziqi Fan. All rights reserved.',

        // Model info
        'type': 'Type',
        'links': 'Links',
        'joints': 'Joints',
        'controllable': 'Controllable',
        'rootLink': 'Root Link',

        // Hover info
        'linkName': 'Link Name',
        'jointName': 'Joint',
        'mass': 'Mass',
        'mergedLinks': 'Merged Links',

        // File types
        'model': 'Model',
        'mesh': 'Mesh',
        'link': 'Link',

        // Units
        'kg': 'kg',
        'rad': 'rad',
        'deg': 'deg',
        'm': 'm',

        // Status messages
        'loading': 'Loading',
        'unsupportedFormat': 'Unsupported file format',
        'loadFailed': 'Load failed',
        'noSupportedFiles': 'No supported files found (URDF, MJCF, DAE, STL, OBJ)',
        'loadSuccess': 'Model loaded successfully',
        'cannotLoadMesh': 'Cannot load mesh file',

        // Editor messages
        'unsavedChanges': 'You have unsaved changes. Are you sure you want to close?',
        'newFile': 'newfile.xml',
        'noFileToReload': 'No file to reload',
        'saveFirst': 'Please save the file first before loading',
        'reloadingModel': 'Reloading model...',
        'modelReloaded': 'Model reloaded (unsaved)',
        'reloadFailed': 'Reload failed',
        'downloadFailed': 'Download failed',
        'fileDownloaded': 'File downloaded',
        'emptyContent': 'Editor content is empty, cannot load',
        'fileType': 'File Type'
    }
};

class I18n {
    constructor() {
        // 检测浏览器语言
        const browserLang = this.detectBrowserLanguage();
        // 从localStorage读取语言设置，如果没有则使用浏览器语言
        this.currentLang = localStorage.getItem('language') || browserLang;
    }

    /**
     * 检测浏览器语言
     */
    detectBrowserLanguage() {
        const lang = navigator.language || navigator.userLanguage;
        // 如果浏览器语言是中文（包括zh, zh-CN, zh-TW等），返回zh-CN
        if (lang.toLowerCase().startsWith('zh')) {
            return 'zh-CN';
        }
        // 否则默认返回英文
        return 'en-US';
    }

    /**
     * 获取翻译文本
     */
    t(key) {
        const lang = translations[this.currentLang] || translations['zh-CN'];
        return lang[key] || key;
    }

    /**
     * 切换语言
     */
    setLanguage(lang) {
        if (translations[lang]) {
            this.currentLang = lang;
            localStorage.setItem('language', lang);
            this.updatePageLanguage();
        }
    }

    /**
     * 获取当前语言
     */
    getCurrentLanguage() {
        return this.currentLang;
    }

    /**
     * 更新页面上所有带有data-i18n属性的元素
     */
    updatePageLanguage() {
        // 更新所有带有data-i18n属性的元素
        document.querySelectorAll('[data-i18n]').forEach(element => {
            const key = element.getAttribute('data-i18n');
            const text = this.t(key);

            // 如果是input或textarea，更新placeholder
            if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
                element.placeholder = text;
            } else {
                // 如果包含HTML标签（如<br>），使用innerHTML
                if (text.includes('<br>') || text.includes('<strong>')) {
                    element.innerHTML = text;
                } else {
                    element.textContent = text;
                }
            }
        });

        // 更新HTML lang属性
        document.documentElement.lang = this.currentLang;
    }

    /**
     * 初始化页面语言
     */
    init() {
        this.updatePageLanguage();
    }
}

// 创建全局实例
export const i18n = new I18n();


