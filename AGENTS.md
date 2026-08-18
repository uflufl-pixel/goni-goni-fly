# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## 프로젝트 개요

클래식 아케이드 게임 **갤러그(Galaga)**의 브라우저 구현. 순수 HTML5 Canvas + 바닐라 JavaScript로 작성되어 **빌드 도구·의존성·번들러가 없다**.

## 실행 방법

`js/game.js`는 `localStorage`(하이스코어 저장)를 사용하므로 `file://`가 아닌 **HTTP로 서빙**해야 한다. `index.html`을 파일로 직접 열면 정상 동작하지 않는다.

```bash
python3 -m http.server 8000
# 브라우저에서 http://localhost:8000/index.html 접속
```

테스트 프레임워크·린터·빌드 스크립트는 없다. JS 문법 검증만 필요하면:

```bash
node --check js/game.js
```

## 아키텍처

전체 게임 로직은 `js/game.js` 하나의 IIFE 안에 있다 (ES module 아님 — `file://`/단순 서버에서도 로드되도록 의도한 것). 핵심 구조:

- **상태 머신**: `state` 변수가 `TITLE → PLAYING → (PAUSED) → GAMEOVER → TITLE` 흐름을 제어한다. `update()`와 `draw()`는 매 프레임 이 상태를 분기한다.
- **메인 루프**: `requestAnimationFrame(loop)`이 델타타임(`dt`) 기반으로 `update(dt)` → `draw()`를 반복. `dt`는 0.05초로 클램프해 프레임 점프를 막는다 (탭 비활성화 등).
- **엔티티 배열**: `enemies`, `playerBullets`, `enemyBullets`, `particles`. 프레임마다 갱신 후 `.filter()`로 죽은 객체를 제거한다.

### 적 편대 시스템 (핵심 로직)

적의 좌표는 **그리드(col/row) → 화면 좌표 변환**으로 계산한다:

- `formationX(col)` / `formationY(row)`: 그리드 인덱스를 픽셀 좌표로 변환. `formation.offsetX`가 좌우 스윙을 만든다.
- 각 적은 `state` 필드로 개별 행동을 가진다: `entering`(화면 밖→자기 자리 진입) → `formation`(편대 대기 + 간헐 사격) → `diving`(사인곡선 급강하 공격 후 화면 아래로 빠지면 재진입).
- `enemyDef(row)`가 행(row)별로 적 종류를 결정: row 0 = `crane`(두루미, 보스 2HP), row 1 = `goose`(기러기), 나머지 = `bird`(철새). 종류마다 색상·점수·HP가 다르다. 주인공은 흰색 고니(백조)로 `drawSwan()`이 그린다. `crane` 판정이 곧 보스 판정(견인빔·폭발 파티클 수)이다.
- 웨이브 클리어(`enemies.length === 0`) 시 `nextLevel()`로 레벨 증가 및 난이도 상승(사격 빈도·급강하 확률이 `level`에 비례).
- **시간 경과 난이도**: `playTime`(누적 플레이 초)을 `timeTier()`가 0~1.5 계수로 환산(시작 0 → 5분 0.5 → 10분 1.0 → 최대 1.5). `updateEnemies()`에서 이 계수(`tf`)로 동시 급강하 수(`maxDivers`)·급강하 확률·편대 사격 확률·급강하 및 탄 속도·견인빔 확률을 함께 끌어올린다. 초반은 완만하고 5·10분이 지날수록 뚜렷이 어려워진다. HUD에 `TIME mm:ss`를 표시(계수 1 이상이면 붉게).

### 충돌 판정

`rectHit(a, b)` AABB 헬퍼로 처리. `checkCollisions()`에서 세 종류를 검사: 플레이어 총알↔적, 적 총알↔플레이어, 급강하 적 몸통↔플레이어. 명중 시 `explode()`로 파티클을 생성하고 죽은 객체를 `filter`로 정리한다. `player.invuln > 0`(부활·도킹 직후 무적)이면 플레이어 피격 검사를 건너뛴다.

### 아이템 / 파워업 (무기 성장)

적을 격추하면 `maybeDropItem()`이 확률적으로 아이템을 떨어뜨린다(두루미 30% > 기러기 14% > 철새 10%). 고니가 받으면 `applyItem()`으로 효과 적용:

- **P(power)**: `weaponLevel` +1 (최대 5). 레벨별 발사 패턴/쿨다운은 `fireCooldown()`·`firePlayer()`가 결정한다 — 1 단발 → 2 연사 → 3 2연발 → 4~5 확산탄(3방향). 확산탄은 총알에 `vx`(수평속도)를 넣어 구현.
- **R(rapid)**: `rapidTime` 동안 쿨다운 단축·탄속 증가.
- **L(laser)**: `laserTime` 동안 일반 탄 대신 레이저빔. `updateLaser()`가 고니 위 세로 기둥에 겹친 적을 `laserCd`(0.1초) 간격으로 다단 히트. `drawLaser()`가 청록 빔을 그린다.
- **D(shield)**: `player.shield` — 피격 1회를 대신 흡수(`hitPlayer()` 최상단 분기). 고니 주위에 링을 그린다.
- **+(life)**: 목숨 +1.

무기·시한부 버프는 `startGame()`에서 초기화되고, 사망 시(`hitPlayer()`) `laserTime`/`rapidTime`은 0으로, `weaponLevel`은 한 단계 하락한다. HUD(`drawHUD()`)에 `PWR n`과 활성 버프(L/R/D)를 표시한다.

### 캡처-구출 & 더블 함선

갤러그의 상징적 기믹. 모듈 전역 `captive`(포획된 함선) 하나로 상태를 관리한다:

1. 보스(row 0)가 `formation`에서 `tractor` 상태로 전환 → 플레이어 위로 하강해 견인빔(`beamOn`) 방출.
2. 빔 안에 플레이어가 일정 시간 머물면 `capturePlayer()`: 목숨 1 소모, `captive.state='held'`로 보스에 매달리고 보스는 `returning`으로 편대 복귀.
3. 그 보스를 격추하면 `releaseCaptive()` → `captive.state='falling'`. 낙하하는 함선을 플레이어가 받아내면 `setDual(true)`로 **더블 함선**(폭 32→64, 총알 2발 동시 발사)이 된다.
4. 더블 함선 피격 시엔 목숨을 잃지 않고 `setDual(false)`로 한 대만 잃는다(`hitPlayer()`).

### 조작 입력

키보드(`keydown`/`keyup` → `keys`)와 포인터/터치를 함께 지원한다. `pointerdown`은 타이틀·게임오버에선 게임을 시작하고, 플레이 중엔 `pointerActive`/`touchFire`를 켜서 **드래그로 함선 이동 + 자동 발사**를 한다. `updatePlayer()`가 두 입력 소스를 모두 반영한다.

## 관례

- 코드·주석·UI 텍스트는 **한국어**로 작성한다.
- 좌표계는 캔버스 픽셀 단위(480×640 고정). 모든 이동은 `속도 × dt`로 계산해 프레임레이트 독립적으로 유지한다.
- 효과음은 외부 파일 없이 WebAudio `beep()`로 즉석 생성한다.
- 배경은 `drawBackground()`가 그리는 **노을 갈대밭**: 세로 그라데이션 하늘(위 어스름 보라→아래 주황·금빛) + 떠다니는 솜털(`fluff`) + 하단 갈대밭. 갈대는 `makeReedLayer()`로 만든 **원경(`reedsBack`)·근경(`reedsFront`) 2겹**을 `drawReedLayer()`가 그린다(줄기 곡선 + 잎사귀 여러 장 + 이삭, `bgTime`으로 흔들림). 편대가 위치한 상단은 어둡게 둬서 흰 두루미·파란 철새의 대비를 확보한다. 갈대는 **고니(`player.y ≈ H-104`)보다 낮게** 그려 시야를 가리지 않는다. 오버레이·HUD 글자는 `centerText`/`drawHUD`에서 어두운 그림자를 넣어 밝은 노을 위에서도 읽히게 한다.
