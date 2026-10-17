# 02engine unpackager

## 简介

该项目是专用于02engine打包器（ https://www.02engine.org ）的解包工具，用于根据打包器预编译的js反编译出较为完整的project.json，虽然可能无法正常使用，但可以用于参考积木逻辑，提取可用积木段等。


## 常见问题Q&A

Q：反编译适用于哪些文件？

A：对于html产物较为友善，对应exe或其他平台则效果较差

Q：反编译的sb3无法正常载入编辑器怎么办？

A：可以尝试使用sb3-fixer修复后再次尝试（ https://github.com/TurboWarp/sb3fix ）

Q：02engine在打包时如果混淆了预编译JS还能反编译嘛？

A：可以，本项目引入了JS反混淆库（webcrack）

Q：本项目可以在Linux及Mac上运行嘛？

A：可以，本项目没有使用Windows底层API


## 基础命令
```bash
node --max-old-space-size=8192 .\bin\unpackager.js <打包作品路径> -o output --verbose
```

### 环境要求

- Node.js >= 20


### 依赖安装
```bash
npm install
```


## 已知限制
- 反编译结果不保证可直接运行，主要用于逻辑参考
- 对高度混淆的代码还原率会下降
- 自定义扩展的积木可能无法完全还原为原生积木


## 开发者联系方式
- 诺言Promise-3813537005（QQ）
- 落日余晖-2037879031（QQ）
- チューリングの幽靈-无联系方式


## 交流群
**QQ：1127725092**


## 免责声明
> [!WARNING]
> **您能够获取某个项目的打包版本，并不必然意味着你在法律上被允许对该项目进行解包、使用、修改、再分发、出售，或以其他方式无视版权法。如需了解更多信息，请咨询该项目的创作者。**
