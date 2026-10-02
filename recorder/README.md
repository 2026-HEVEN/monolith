# monolith live telemetry recorder

로거가 MQTT로 보내는 라이브 텔레메트리(`{name}/d/#`)를 SD 로그와 같은 `.log` 포맷으로 계속 저장한다.
웹 `/viewer`와 `web/src/service/heven.js`의 `analyze()`가 그대로 읽는다.

- 로거 부팅 1회 = 파일 1개: `~/telemetry/YYYY-MM-DD-HH-MM-SS.live.log` (부팅 시각, KST)
- 라이브 CAN은 펌웨어가 ID별로 `intv`마다 1프레임만 보낸다(100ms → ID당 최대 10Hz). 100ms보다 짧은 현상은 SD 로그로 확인할 것.
- 상태: `~/telemetry/status.json`

## 운영 (omo)

```bash
# 배포/갱신
rsync -az --exclude node_modules --exclude data --exclude test ./ omo:~/monolith-recorder/
ssh omo 'docker restart monolith-recorder'

# 최초 설치 (.env: MQTT_HOST, MQTT_USER, MQTT_PASS, TZ)
ssh omo 'cd ~/monolith-recorder && docker run --rm --runtime=runc -v $PWD:/app -w /app node:22-alpine npm install --omit=dev'
ssh omo 'docker run -d --name monolith-recorder --runtime=runc --restart unless-stopped --env-file $HOME/monolith-recorder/.env -e OUT_DIR=/data -v $HOME/monolith-recorder:/app:ro -v $HOME/telemetry:/data -w /app --log-opt max-size=5m --log-opt max-file=2 node:22-alpine node recorder.mjs'

# 로그
ssh omo 'docker logs --tail 50 monolith-recorder'
```

## 도구

```bash
node live.mjs                          # omo의 최신 live 로그 요약 + 이벤트
node live.mjs --since 300              # 300초 이후 이벤트만
node test/replay.mjs <sd.log> [100]    # SD 로그를 MQTT 스트림처럼 재생해 녹화기 검증
node --env-file=.env set-intv.mjs 100  # 로거가 온라인이 되면 intv 설정 (다음 부팅부터 적용)
```
