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
        'lighting': '光照',
        'grid': '网格',
        'files': '文件',
        'joints': '关节',
        'structure': '结构',
        'edit': '编辑',
        'animation': '动画',
        'help': '帮助',
        'theme': '主题',
        'language': '语言',

        // 面板标题
        'fileList': '文件',
        'jointControl': '关节',
        'modelStructure': '结构',
        'codeEditor': '编辑',
        'animationEditor': '动画编辑器',
        'animationExperimental': '实验功能 · 仍在开发中',

        // 动画编辑器
        'autoKey': '自动关键帧',
        'addKeyframe': '添加关键帧',
        'deleteKeyframe': '删除关键帧',
        'time': '时间',
        'duration': '时长',
        'loop': '循环',
        'importAnimation': '导入',
        'exportAnimation': '导出',
        'animationNoModel': '请加载 URDF、Xacro 或 MJCF 模型后制作动画。',
        'animationHint': '双击轨道添加关键帧；拖动菱形可调整关键帧时间。',
        'dopeSheet': '时间表',
        'graphView': '曲线',
        'addMarker': '标记',
        'addMedia': '媒体',
        'snapFrames': '吸附 30fps',
        'zoom': '缩放',
        'keyTime': '关键帧时间',
        'keyValue': '数值',
        'interpolation': '插值',
        'autoSmooth': '自动平滑',
        'smooth': '平滑',
        'broken': '自由手柄',
        'linear': '线性',
        'step': '阶跃',
        'selectionHint': 'Shift 多选，Ctrl/Cmd 切换选择，拖动空白区域框选。',
        'animationName': '动画名称',
        'markerName': '标记名称',
        'animationGuideStartTitle': '先记录起始姿势',
        'animationGuideStartText': '保持模型当前姿势，点击“记录起始姿势”。系统会记录全部关节并自动前进 1 秒。',
        'animationGuideStartButton': '记录起始姿势',
        'animationGuideAdjustTitle': '调整下一个姿势',
        'animationGuideAdjustText': '时间已到 {time}。在左侧关节面板拖动滑块，自动关键帧会记录变化；完成后继续。',
        'animationGuideContinueTitle': '继续添加姿势',
        'animationGuideContinueText': '已有 {count} 个姿势时间点，当前 {time}。调整模型后记录并前进，或直接播放预览。',
        'animationGuideRecord': '记录当前姿势',
        'animationGuideNext': '记录并前进 1 秒',
        'animationGuidePlay': '播放',
        'animationPoseRecorded': '已在 {time} 记录 {count} 个关节',
        'animationPoseRecordedNext': '姿势已记录，时间已前进到 {time}',
        'animationAutoKeyOn': '自动关键帧已开启：调整关节后会自动记录',
        'animationAutoKeyOff': '自动关键帧已关闭',
        'animationAutoKeyed': '已自动记录 {joint} · {time}',
        'animationImported': '已导入动画“{name}”',
        'animationAdd': '添加',
        'animationAddPose': '记录当前完整姿势',
        'animationAddPoseNext': '记录姿势并前进 1 秒',
        'animationAddSelectedKey': '仅给选中轨道添加关键帧',
        'animationAddMedia': '添加音频或视频',
        'animationAddEvent': '添加事件轨道',
        'animationAddMarker': '添加时间标记',
        'animationSavePose': '保存为可复用姿势',
        'animationKeySavedPose': '记录已保存姿势',
        'animationAudioReactive': '从音频生成关键帧',

        // 关节控制
        'radian': '弧度',
        'degree': '角度',
        'reset': '重置',
        'limits': '限位',

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
        'aboutContent': 'Robot Viewer 是一个基于 Three.js 的网页端机器人模型 3D 查看器，提供直观的可视化界面，帮助您在浏览器中查看和分析机器人的结构、关节和物理属性，无需安装任何软件。<br><br>格式支持：URDF、Xacro、MJCF、USD（部分支持）<br>机器人类型：串联机器人结构（暂不支持并联机器人）<br><br>由 <strong>范子琦</strong> 开发。',
        'projectHome': '项目主页',
        'email': '邮箱',
        'myGithub': '我的GitHub',
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
        'load': '加载',
        'loadFiles': '加载文件',
        'loadFolder': '加载文件夹',
        'orClickButton': '或点击下面的按钮加载',
        'noControllableJoints': '未找到可控制关节',
        'clickToEditMin': '点击编辑下限',
        'clickToEditMax': '点击编辑上限',
        'dropHint': '拖拽机器人模型文件或文件夹到页面任意位置',
        'dropHintSub': '支持 URDF, Xacro, MJCF 格式<br>支持拖拽文件夹以加载mesh文件',
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
        'noSupportedFiles': '未找到支持的文件（URDF, Xacro, MJCF, DAE, STL, OBJ）',
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
        'lighting': 'Lighting',
        'grid': 'Grid',
        'files': 'Files',
        'joints': 'Joints',
        'structure': 'Structure',
        'edit': 'Edit',
        'animation': 'Animation',
        'help': 'Help',
        'theme': 'Theme',
        'language': 'Language',

        // Panel titles
        'fileList': 'Files',
        'jointControl': 'Joints',
        'modelStructure': 'Structure',
        'codeEditor': 'Editor',
        'animationEditor': 'Animation Editor',
        'animationExperimental': 'Experimental · In development',

        // Animation editor
        'autoKey': 'Auto Key',
        'addKeyframe': 'Add Key',
        'deleteKeyframe': 'Delete Key',
        'time': 'Time',
        'duration': 'Duration',
        'loop': 'Loop',
        'importAnimation': 'Import',
        'exportAnimation': 'Export',
        'animationNoModel': 'Load a URDF, Xacro or MJCF model to animate it.',
        'animationHint': 'Double-click a track to add a keyframe. Drag a diamond to move it.',
        'dopeSheet': 'Dope Sheet',
        'graphView': 'Graph',
        'addMarker': 'Marker',
        'addMedia': 'Media',
        'snapFrames': 'Snap 30fps',
        'zoom': 'Zoom',
        'keyTime': 'Key Time',
        'keyValue': 'Value',
        'interpolation': 'Interpolation',
        'autoSmooth': 'Auto Smooth',
        'smooth': 'Smooth',
        'broken': 'Broken',
        'linear': 'Linear',
        'step': 'Step',
        'selectionHint': 'Shift adds, Ctrl/Cmd toggles, and dragging empty space box-selects.',
        'animationName': 'Animation name',
        'markerName': 'Marker name',
        'animationGuideStartTitle': 'Record the starting pose',
        'animationGuideStartText': 'Leave the model in its current pose. This records every joint and moves the playhead forward by one second.',
        'animationGuideStartButton': 'Record starting pose',
        'animationGuideAdjustTitle': 'Create the next pose',
        'animationGuideAdjustText': 'The playhead is at {time}. Adjust joints in the Joints panel; Auto Key records each change. Continue when the pose is ready.',
        'animationGuideContinueTitle': 'Keep adding poses',
        'animationGuideContinueText': '{count} pose times are ready. You are at {time}; adjust the model, record and advance, or preview the result.',
        'animationGuideRecord': 'Record current pose',
        'animationGuideNext': 'Record and advance 1s',
        'animationGuidePlay': 'Play',
        'animationPoseRecorded': 'Recorded {count} joints at {time}',
        'animationPoseRecordedNext': 'Pose recorded; moved to {time}',
        'animationAutoKeyOn': 'Auto Key is on: joint changes will be recorded',
        'animationAutoKeyOff': 'Auto Key is off',
        'animationAutoKeyed': 'Auto-keyed {joint} at {time}',
        'animationImported': 'Imported “{name}”',
        'animationAdd': 'Add',
        'animationAddPose': 'Record current pose',
        'animationAddPoseNext': 'Record pose and advance 1s',
        'animationAddSelectedKey': 'Key selected track only',
        'animationAddMedia': 'Add audio or video',
        'animationAddEvent': 'Add event track',
        'animationAddMarker': 'Add time marker',
        'animationSavePose': 'Save reusable pose',
        'animationKeySavedPose': 'Key saved pose',
        'animationAudioReactive': 'Generate keys from audio',

        // Joint control
        'radian': 'Radian',
        'degree': 'Degree',
        'reset': 'Reset',
        'limits': 'Limits',

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
        'aboutContent': 'Robot Viewer is a web-based 3D viewer for robot models and scenes. Built on top of Three.js, it provides an intuitive interface for visualizing, editing, and simulating robots directly in the browser without any installation required. This tool helps you visualize and analyze robot structures, joints, and physical properties.<br><br>Format Support: URDF, Xacro, MJCF, USD (partial support)<br>Robot Types: Serial robot structures (parallel robots not currently supported)<br><br>Developed by <strong>Ziqi Fan</strong>.',
        'projectHome': 'Project Home',
        'email': 'Email',
        'myGithub': 'My GitHub',
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
        'load': 'Load',
        'loadFiles': 'Load Files',
        'loadFolder': 'Load Folder',
        'orClickButton': 'or click the button below to load',
        'noControllableJoints': 'No Controllable Joints Found',
        'clickToEditMin': 'Click to edit minimum',
        'clickToEditMax': 'Click to edit maximum',
        'dropHint': 'Drag and drop robot model files or folders anywhere',
        'dropHintSub': 'Supports URDF, Xacro, MJCF formats<br>Supports folder dragging to load mesh files',
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
        'noSupportedFiles': 'No supported files found (URDF, Xacro, MJCF, DAE, STL, OBJ)',
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
