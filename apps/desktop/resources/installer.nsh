; PictureX 查看器文件关联（自定义 NSIS 片段，electron-builder 自动包含 resources/installer.nsh）。
;
; 需求：注册为图片/视频的「打开方式」候选，但绝不成为系统默认查看器。
; 因此这里只：
;   1. 建 PictureX.<ext> 这个 ProgID（friendly 名 + 打开命令，命令行把文件路径作为 %1 传给主进程 argv）；
;   2. 把 ProgID 追加到 Software\Classes\<.ext>\OpenWithProgids（候选列表）。
; 不写 Software\Classes\<.ext> 的默认值，也不设 UserChoice——保持用户当前的默认查看器不变。

!macro PX_VIEWER_ASSOC EXT PROGID DESC
    WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}" "" "${DESC}"
    WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\DefaultIcon" "" "$appExe,0"
    WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\Shell\Open\Command" "" '"$appExe" "%1"'
    WriteRegNone SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
!macroend

!macro PX_VIEWER_UNASSOC EXT PROGID
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
    DeleteRegKey SHELL_CONTEXT "Software\Classes\${PROGID}"
!macroend

!macro customInstall
    ; 图片
    !insertmacro PX_VIEWER_ASSOC "jpg" "PictureX.jpg" "PictureX Image"
    !insertmacro PX_VIEWER_ASSOC "jpeg" "PictureX.jpeg" "PictureX Image"
    !insertmacro PX_VIEWER_ASSOC "png" "PictureX.png" "PictureX Image"
    !insertmacro PX_VIEWER_ASSOC "webp" "PictureX.webp" "PictureX Image"
    !insertmacro PX_VIEWER_ASSOC "gif" "PictureX.gif" "PictureX Image"
    !insertmacro PX_VIEWER_ASSOC "bmp" "PictureX.bmp" "PictureX Image"
    !insertmacro PX_VIEWER_ASSOC "avif" "PictureX.avif" "PictureX Image"
    !insertmacro PX_VIEWER_ASSOC "svg" "PictureX.svg" "PictureX Image"
    ; 视频
    !insertmacro PX_VIEWER_ASSOC "mp4" "PictureX.mp4" "PictureX Video"
    !insertmacro PX_VIEWER_ASSOC "m4v" "PictureX.m4v" "PictureX Video"
    !insertmacro PX_VIEWER_ASSOC "webm" "PictureX.webm" "PictureX Video"
    !insertmacro PX_VIEWER_ASSOC "mov" "PictureX.mov" "PictureX Video"
!macroend

!macro customUnInstall
    !insertmacro PX_VIEWER_UNASSOC "jpg" "PictureX.jpg"
    !insertmacro PX_VIEWER_UNASSOC "jpeg" "PictureX.jpeg"
    !insertmacro PX_VIEWER_UNASSOC "png" "PictureX.png"
    !insertmacro PX_VIEWER_UNASSOC "webp" "PictureX.webp"
    !insertmacro PX_VIEWER_UNASSOC "gif" "PictureX.gif"
    !insertmacro PX_VIEWER_UNASSOC "bmp" "PictureX.bmp"
    !insertmacro PX_VIEWER_UNASSOC "avif" "PictureX.avif"
    !insertmacro PX_VIEWER_UNASSOC "svg" "PictureX.svg"
    !insertmacro PX_VIEWER_UNASSOC "mp4" "PictureX.mp4"
    !insertmacro PX_VIEWER_UNASSOC "m4v" "PictureX.m4v"
    !insertmacro PX_VIEWER_UNASSOC "webm" "PictureX.webm"
    !insertmacro PX_VIEWER_UNASSOC "mov" "PictureX.mov"
!macroend
