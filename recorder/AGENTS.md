# 라이브 텔레메트리 분석 안내 (AI 에이전트용)

HEVEN 차량의 monolith 로거가 주행 중 MQTT로 보내는 데이터를 녹화기가 서버에 계속 저장한다.
이 문서는 그 녹화본을 받아 분석하는 방법이다. 설치할 것은 Node 18 이상뿐이고 `npm install`은 필요 없다.

## 데이터 위치
- 목록(JSON): https://omo.tail0d4a7c.ts.net:10000/live/
- 파일: `https://omo.tail0d4a7c.ts.net:10000/live/<YYYY-MM-DD-HH-MM-SS>.live.log` (로거 부팅 시각, KST)
- 녹화기 상태: `.../live/status.json` (`device.online`이 true면 주행·수신 중)
- 로거 부팅 1회 = 파일 1개. 수신 중인 파일은 계속 커진다.

## 명령 (레포 루트에서)
```bash
node recorder/live.mjs --list                      # 녹화본 목록, 수신 중 표시
node recorder/live.mjs                             # 최신 녹화본 요약 + 이벤트
node recorder/live.mjs <이름>.live.log              # 특정 녹화본
node recorder/live.mjs --since 600                 # 로그 시각 600초 이후 이벤트만
node recorder/live.mjs <이름>.live.log --csv out.csv --dt 0.1   # 전 채널 CSV (직접 분석용)
node recorder/live.mjs ./local.log                 # 로컬 파일(SD 로그도 가능)
```
- 출력 시각 `t`/`t_s`는 로거 부팅 후 경과 초다. CSV의 `wall_ms`는 epoch 밀리초다.
- CSV 열 이름·단위·뜻은 `--csv` 실행 시 `columns:` 줄에 나온다. 정의는 `web/src/service/heven.js`의 `CHANNELS`에 있다.
- 이벤트(`*` = 주요): HV 차단 추정, BMS 과전류, 컨트롤러 피드백 두절, VCU 출력 차단 사유, 노드 리셋 원인, 로거 시스템 메시지.

## 디코딩 기준
- CAN ID와 필드 해석은 `web/src/service/heven.js`(`ID`, `CHANNELS`, `analyze`)에 있다. 원본 계약은 VCU 레포의 `include/can_protocol.h`다.
- 파일 포맷은 SD 로그와 같다: 24바이트 레코드(magic 0xAE, type, XOR 체크섬, timestamp ms, payload 16B), 첫 레코드는 BOOT 헤더. 파서는 `web/src/service/protocol.js`의 `parse`다.

## 라이브 데이터의 한계 (결론 낼 때 반드시 고려)
- 로거는 CAN을 **ID마다 텔레메트리 간격(intv, 기본 100ms)에 1프레임씩만** 보낸다. 그래서 ID당 최대 10Hz다. 평균이 아니라 표본이다.
- 그 결과 피크 값이 낮게 나온다(예: 전력 최대치 10.7kW가 9.2kW로 나온 사례가 있다). 0.1초보다 짧은 현상은 빠지고, 두절 길이는 약 0.05초 길게 나온다.
- 500ms 이동평균 10kW 판정이나 ms 단위 현상은 라이브 데이터로 확정하지 말고 SD 로그로 확인한다.
- 로거가 Wi-Fi(핫스팟)를 잃은 구간은 녹화본에 빈 구간으로 남는다. 레코드가 비어 있다고 해서 차량 쪽 두절로 단정하지 않는다.
- BOOT 헤더의 MAC은 00:00:00:00:00:00으로 기록된다(MQTT로는 오지 않는다).
