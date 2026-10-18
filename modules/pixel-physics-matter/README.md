# PixelPhysics용 Matter.js

픽셀 물리와 강체를 함께 사용할 때만 가져오는 Matter.js 0.19.0 ESM 번들입니다. MIT 라이선스의 원본 런타임을 빌드에 포함하며, 외부 CDN이나 전역 `window.Matter`에 의존하지 않습니다. 픽셀 전용 `pixel-physics.js`에는 Matter.js가 들어가지 않습니다.

```js
import { PixelWorld, MatterBridge } from './pixel-physics.js';
import { Matter } from './pixel-physics-matter.js';
const WORLD = new PixelWorld(200, 120, { seed: 1 });
WORLD.attachBridge(new MatterBridge(Matter));
```

원본: [Matter.js v0.19.0](https://github.com/liabru/matter-js/tree/0.19.0). 버전과 무결성은 저장소 package-lock.json, 최종 배포 bytes는 manifest.json에서 확인합니다. 물리 API와 스냅샷 제한은 [pixel-physics](../pixel-physics/README.md)를 따릅니다.
