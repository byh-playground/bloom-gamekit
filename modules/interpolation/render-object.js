/** 보간 객체의 좁은 공통 계약. 시뮬레이션·입력·타이머를 소유하지 않습니다. */
export class RenderObject {
  static LINEAR = 0;
  static ANGLE = 1;
  static STEP = 2;
  // 타격 flash처럼 값이 증가하면 새 표현으로 즉시 시작합니다.
  static DECAY = 3;
  // 0..1 진행률이 1에서 0으로 순환하는 필드. 종료 때 역방향 보간하지 않습니다.
  static CYCLE = 4;
  static renderSchema = Object.freeze({});

  /** @param {unknown} context @param {object} model */
  render(context, model) {
    throw new Error('RenderObject 하위 타입은 render(context, model)을 구현해야 합니다.');
  }
}
