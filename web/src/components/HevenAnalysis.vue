<script setup>
  import {ref, computed, watch, nextTick, onBeforeUnmount, shallowRef, triggerRef} from 'vue';
  import {dark} from '@/layout/composables/layout';
  import {colors} from '@/service/ui';
  import {
    PANELS, CHANNELS, FLAG_LANES, EVENT_CATS,
    resample, range_stats, set_threshold, to_csv,
  } from '@/service/heven';

  import uPlot from 'uplot';
  import 'uplot/dist/uPlot.min.css';
  import dayjs from 'dayjs/esm';

  const props = defineProps({
    analysis: {type: Object, required: true},
    boot: {type: Number, default: 0},
    name: {type: String, default: 'log'},
  });

  const an = shallowRef(props.analysis);
  watch(() => props.analysis, v => { an.value = v; threshold.value = v.threshold; rebuild(); });

  /* ---- threshold / summary ---- */

  const threshold = ref(props.analysis.threshold);
  watch(threshold, v => {
    if (!(v > 0)) return;
    set_threshold(an.value, v);
    triggerRef(an);
    update_stats();
    charts.forEach(u => u.redraw());
  });

  const summary = computed(() => an.value.summary);

  const n1 = v => v === null || v === undefined || !isFinite(v) ? '-' : (Math.round(v * 10) / 10 + 0).toLocaleString();
  const n0 = v => v === null || v === undefined || !isFinite(v) ? '-' : Math.round(v).toLocaleString();
  const at = st => st ? ` @ ${st.toFixed(1)}s` : '';

  const cards = computed(() => {
    const s = summary.value;
    return [
      {label: '주행 시간', value: `${Math.floor(s.duration / 60)}분 ${Math.round(s.duration % 60)}초`},
      {label: '최고 차속 (VCU)', value: `${n1(s.speed?.max)} km/h`, sub: at(s.speed?.t_max)},
      {label: '주행 거리 (모터 환산)', value: `${n1(s.distance_km * 1000)} m`},
      ...(s.em_frames ? [
        {label: '소비 에너지 (EM)', value: `${n1(s.em_energy_wh)} Wh`, sub: `컨트롤러 ${n1(s.energy_wh)} Wh`},
        {label: '최대 전력 (EM)', value: `${n1(s.em_p?.max)} kW`, sub: at(s.em_p?.t_max), warn: s.em_p?.max > 10},
        {label: '최대 전류 (EM)', value: `${n0(s.em_i?.max)} A`, sub: at(s.em_i?.t_max)},
      ] : [
        {label: '소비 에너지 (컨트롤러)', value: `${n1(s.energy_wh)} Wh`},
      ]),
      {label: '최대 버스전류 합계', value: `${n0(s.ibus_sum?.max)} A`, sub: at(s.ibus_sum?.t_max)},
      {label: '최대 DC 전력', value: `${n1(s.p_dc?.max)} kW`, sub: at(s.p_dc?.t_max)},
      {label: '부하 중 최저 전압', value: `${n1(s.loaded_v?.min)} V`, sub: at(s.loaded_v?.t_min)},
      {label: 'BMS 최대 방전 / 최저 팩전압', value: `${n0(s.bms_dis?.max)} A / ${n1(s.bms_v?.min)} V`},
      {label: `합계 ${an.value.threshold}A 초과 누적`, value: `${s.over.toFixed(2)} 초`, warn: s.over > 0.5},
      {label: 'HV 차단 추정', value: `${s.hv_cuts} 회`, warn: s.hv_cuts > 0},
      {label: 'VCU 두절 / MCU 에러', value: `${s.vcu_events} / ${s.mcu_errors}`, warn: s.vcu_events + s.mcu_errors > 0},
      {label: '핸드셰이크 요청 / 로거 CAN 경보', value: `${s.probes} / ${s.alerts}`},
      {label: '주행 중 차속 무효 비율', value: s.wss_invalid_pct === null ? '-' : `${n1(s.wss_invalid_pct)} %`},
      {label: 'SOC', value: s.soc ? `${n0(s.soc.max)} → ${n0(s.soc.min)} %` : '-'},
    ];
  });

  /* ---- events ---- */

  const cat_filter = ref(Object.keys(EVENT_CATS).filter(k => k !== 'WSS' && k !== 'STATE'));
  const key_only = ref(false);
  const cat_options = Object.entries(EVENT_CATS).map(([value, c]) => ({value, label: c.name}));

  const cat_count = computed(() => {
    const c = {};
    an.value.events.forEach(e => c[e.cat] = (c[e.cat] || 0) + 1);
    return c;
  });

  const events = computed(() => an.value.events.filter(e =>
    cat_filter.value.includes(e.cat) && (!key_only.value || e.key)));

  const wall = t => props.boot ? dayjs(props.boot * 1000 + t * 1000).format('HH:mm:ss.SSS') : '';

  function goto_event(e) {
    /* long events (HV off for 37 s, VCU silent to EOF) zoom on their onset */
    const a = e.t - 3, b = Math.min(e.end ?? e.t, e.t + 12) + 3;
    zoom(Math.max(an.value.t0, a), Math.min(an.value.t1, b));
    plots.value?.scrollIntoView({behavior: 'smooth', block: 'start'});
  }

  /* ---- charts ---- */

  const visible = ref(['speed', 'current', 'command', 'voltage', 'flags']);
  const plots = ref(null);
  const hosts = {};
  const charts = new Map();
  const range = ref(null);
  const stats = ref(null);
  let syncing = false;

  const panel_list = computed(() => PANELS.filter(p => visible.value.includes(p.key)));

  const marker_color = {
    HV: '#ef4444', VCU: '#ef4444', MCU: '#f97316', CAN: '#eab308', BMS: '#a855f7',
    WSS: '#3b82f6', STATE: '#9ca3af', SYS: '#9ca3af', RST: '#ec4899',
  };

  /* the charts mark exactly the events the timeline currently lists, so the
   * category chips and the 주요만 switch also filter the lines */
  watch(events, () => charts.forEach(u => u.redraw()));

  function plugin_markers() {
    return {
      hooks: {
        draw: u => {
          const {ctx, bbox} = u;
          const [xmin, xmax] = [u.scales.x.min, u.scales.x.max];
          ctx.save();
          for (const e of events.value) {
            if (e.t < xmin || e.t > xmax) continue;
            const x = Math.round(u.valToPos(e.t, 'x', true));
            // 주요 이벤트는 진한 실선, 나머지는 옅은 점선
            ctx.globalAlpha = e.key ? 1 : 0.55;
            ctx.lineWidth = (e.key ? 1.5 : 1) * devicePixelRatio;
            ctx.strokeStyle = marker_color[e.cat] || '#9ca3af';
            ctx.setLineDash(e.key ? [] : [4, 4]);
            ctx.beginPath();
            ctx.moveTo(x, bbox.top);
            ctx.lineTo(x, bbox.top + bbox.height);
            ctx.stroke();
          }
          ctx.restore();
        },
      },
    };
  }

  function plugin_wheel() {
    return {
      hooks: {
        ready: u => {
          u.over.addEventListener('wheel', e => {
            e.preventDefault();
            const {t0, t1} = an.value;
            const x = u.posToVal(u.cursor.left, 'x');
            const pct = u.cursor.left / u.over.clientWidth;
            let w = (u.scales.x.max - u.scales.x.min) * (e.deltaY < 0 ? 0.75 : 1 / 0.75);
            w = Math.min(w, t1 - t0);
            let a = x - pct * w, b = a + w;
            if (a < t0) { a = t0; b = t0 + w; }
            if (b > t1) { b = t1; a = t1 - w; }
            zoom(a, b);
          }, {passive: false});
        },
      },
    };
  }

  function axis_style() {
    return {
      stroke: () => dark.value ? '#fff' : '#000',
      ticks: {stroke: () => dark.value ? '#24282b' : '#ededed'},
      grid: {stroke: () => dark.value ? '#24282b' : '#ededed'},
    };
  }

  function make_chart(panel, el) {
    const chans = CHANNELS.filter(c => c.panel === panel.key);
    const dt = an.value.t1 - an.value.t0 > 1200 ? 0.02 : 0.01;
    const {x, cols} = resample(an.value, chans.map(c => c.key), dt);

    let data = cols;
    if (panel.lanes) {
      data = cols.map((y, k) => y.map(v => v === null ? null : chans[k].lane + (v ? 0.7 : 0)));
    }

    const series = [{
      label: '시각',
      value: (u, v) => v === null ? '-' : `${v.toFixed(2)}s ${wall(v)}`,
    }];
    chans.forEach(c => {
      series.push({
        label: c.label,
        stroke: colors[CHANNELS.indexOf(c) % colors.length],
        width: 1.25,
        show: c.show !== false,
        spanGaps: false,
        paths: panel.lanes ? uPlot.paths.stepped({align: 1}) : undefined,
        value: panel.lanes
          ? (u, v) => v === null ? '-' : (v - c.lane > 0.35 ? 'ON' : 'off')
          : (u, v) => v === null ? '-' : `${(Math.round(v * 10) / 10)} ${c.unit || ''}`,
      });
    });

    const height = panel.lanes ? 300 : 220;
    const axes = [
      {...axis_style(), size: 30, values: (u, v) => v.map(x => `${x.toFixed(x % 1 ? 1 : 0)}s`)},
      panel.lanes
        ? {
          ...axis_style(), size: 90,
          splits: () => chans.map(c => c.lane + 0.35),
          values: () => chans.map(c => c.label),
        }
        : {...axis_style(), size: 60, values: (u, v) => v.map(y => `${y}${panel.unit}`)},
    ];

    const opts = {
      width: el.clientWidth || 600,
      height,
      cursor: {sync: {key: 'heven', setSeries: false}, drag: {x: true, y: false, setScale: true}},
      scales: {
        x: {time: false},
        y: panel.lanes ? {range: [-0.3, FLAG_LANES]} : {},
      },
      axes,
      series,
      legend: {live: true},
      plugins: [plugin_markers(), plugin_wheel()],
      hooks: {
        setScale: [(u, key) => {
          if (key !== 'x' || syncing) return;
          const {min, max} = u.scales.x;
          syncing = true;
          charts.forEach(o => { if (o !== u) o.setScale('x', {min, max}); });
          syncing = false;
          range.value = [min, max];
          update_stats();
        }],
      },
    };

    const u = new uPlot(opts, [Array.from(x), ...data], el);
    if (range.value) {
      syncing = true;
      u.setScale('x', {min: range.value[0], max: range.value[1]});
      syncing = false;
    }
    return u;
  }

  function destroy_all() {
    charts.forEach(u => u.destroy());
    charts.clear();
  }

  async function rebuild() {
    destroy_all();
    range.value = null;
    await nextTick();
    render_panels();
    update_stats();
  }

  function render_panels() {
    for (const p of panel_list.value) {
      if (charts.has(p.key) || !hosts[p.key]) continue;
      charts.set(p.key, make_chart(p, hosts[p.key]));
    }
    for (const [k, u] of charts) {
      if (!visible.value.includes(k)) { u.destroy(); charts.delete(k); }
    }
  }

  watch(visible, async () => { await nextTick(); render_panels(); update_stats(); });

  function zoom(a, b) {
    const first = charts.values().next().value;
    if (first) first.setScale('x', {min: a, max: b});
    else { range.value = [a, b]; update_stats(); }
  }

  function reset_zoom() {
    zoom(an.value.t0, an.value.t1);
  }

  const resize = new ResizeObserver(() => {
    charts.forEach((u, key) => {
      const w = hosts[key]?.clientWidth;
      if (w && w !== u.width) u.setSize({width: w, height: u.height});
    });
  });

  watch(plots, el => { if (el) resize.observe(el); });

  onBeforeUnmount(() => { resize.disconnect(); destroy_all(); });

  /* ---- range stats ---- */

  let stats_timer = null;

  function update_stats() {
    clearTimeout(stats_timer);
    stats_timer = setTimeout(() => {
      const [a, b] = range.value || [an.value.t0, an.value.t1];
      stats.value = range_stats(an.value, a, b);
    }, 80);
  }

  const stat_rows = computed(() => {
    if (!stats.value) return [];
    return CHANNELS
      .filter(c => visible.value.includes(c.panel) && c.panel !== 'flags')
      .map(c => ({c, s: stats.value.channels[c.key]}))
      .filter(r => r.s);
  });

  /* ---- CSV ---- */

  function download_csv(whole) {
    const [a, b] = whole || !range.value ? [an.value.t0, an.value.t1] : range.value;
    const csv = to_csv(an.value, a, b, 0.01, props.boot);
    const blob = new Blob([csv], {type: 'text/csv'});
    const url = URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.href = url;
    el.download = `${props.name.replace(/\.log$/, '')}_${a.toFixed(1)}-${b.toFixed(1)}s.csv`;
    document.body.appendChild(el);
    el.click();
    document.body.removeChild(el);
    URL.revokeObjectURL(url);
  }

  const set_host = key => el => { if (el) hosts[key] = el; else delete hosts[key]; };

  nextTick(() => { render_panels(); update_stats(); });
</script>

<template>
  <div class="flex flex-col gap-8">
    <div class="card">
      <div class="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div class="font-semibold text-xl">HEVEN 요약</div>
        <div class="flex items-center gap-2">
          <label for="thr" class="text-sm opacity-70">BMS 과전류 문턱 (합계)</label>
          <InputNumber inputId="thr" v-model="threshold" suffix=" A" :min="1" :max="2000" :inputStyle="{width: '6.5rem'}" size="small" />
        </div>
      </div>
      <div class="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
        <div v-for="c in cards" :key="c.label" class="cardview" :class="{'border-red-400': c.warn}">
          <div class="text-xs opacity-70">{{ c.label }}</div>
          <div class="text-lg font-semibold" :class="{'text-red-500': c.warn}">{{ c.value }}</div>
          <div v-if="c.sub" class="text-xs opacity-60">{{ c.sub }}</div>
        </div>
      </div>
      <div v-if="summary.em_frames === 0" class="text-xs opacity-60 mt-3">
        <span class="pi pi-info-circle mr-1"></span>에너지미터 프레임 없음. 전류·에너지는 컨트롤러 보고값 기준입니다.
      </div>
    </div>

    <div class="card">
      <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div class="font-semibold text-xl">이벤트 타임라인</div>
        <div class="flex flex-wrap items-center gap-3">
          <SelectButton v-model="cat_filter" :options="cat_options" optionLabel="label" optionValue="value" multiple size="small">
            <template #option="{option}">
              {{ option.label }} <span class="opacity-60 ml-1">{{ cat_count[option.value] || 0 }}</span>
            </template>
          </SelectButton>
          <div class="flex items-center gap-2">
            <ToggleSwitch inputId="key_only" v-model="key_only" />
            <label for="key_only" class="text-sm">주요만</label>
          </div>
        </div>
      </div>
      <DataTable :value="events" size="small" scrollable scrollHeight="360px" selectionMode="single"
        @rowClick="goto_event($event.data)" class="cursor-pointer">
        <template #empty><div class="p-4 text-center text-gray-400">해당하는 이벤트가 없습니다.</div></template>
        <Column header="시각" style="width: 9rem">
          <template #body="{data}">
            <div class="font-mono text-sm">{{ data.t.toFixed(2) }}s</div>
            <div class="font-mono text-xs opacity-60">{{ wall(data.t) }}</div>
          </template>
        </Column>
        <Column header="분류" style="width: 6rem">
          <template #body="{data}">
            <Tag :value="EVENT_CATS[data.cat].name" :severity="EVENT_CATS[data.cat].severity" />
          </template>
        </Column>
        <Column header="내용">
          <template #body="{data}">
            <span :class="{'font-semibold': data.key}">{{ data.msg }}</span>
          </template>
        </Column>
      </DataTable>
      <div class="text-xs opacity-60 mt-2"><span class="pi pi-info-circle mr-1"></span>행을 누르면 그래프가 해당 구간(±3초)으로 이동합니다.</div>
    </div>

    <div class="card" ref="plots">
      <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div class="font-semibold text-xl">그래프</div>
        <div class="flex flex-wrap gap-2">
          <Button label="전체 보기" icon="pi pi-search-minus" size="small" severity="secondary" @click="reset_zoom" />
          <Button label="보이는 구간 CSV" icon="pi pi-download" size="small" severity="info" @click="download_csv(false)" />
          <Button label="전체 CSV" icon="pi pi-download" size="small" severity="secondary" outlined @click="download_csv(true)" />
        </div>
      </div>
      <SelectButton v-model="visible" :options="PANELS" optionLabel="name" optionValue="key" multiple size="small" class="mb-4 flex-wrap" />
      <div class="text-xs opacity-60 mb-4">
        <span class="pi pi-info-circle mr-1"></span>드래그로 확대, 휠로 확대·축소, 더블클릭으로 원복. 범례를 누르면 채널을 켜고 끕니다.
        세로선은 위 이벤트 타임라인에 보이는 이벤트와 같습니다(분류·주요만 필터 적용). 주요 이벤트는 실선, 나머지는 점선:
        <span class="text-red-500">HV·VCU</span> / <span class="text-orange-500">MCU</span> /
        <span class="text-yellow-500">CAN</span> / <span class="text-purple-500">BMS 문턱</span> /
        <span class="text-blue-500">WSS</span> / <span class="text-gray-400">상태·SYS</span>
      </div>
      <div v-for="p in panel_list" :key="p.key" class="mb-4">
        <div class="font-semibold mb-1">{{ p.name }} <span v-if="p.unit" class="opacity-60 text-sm">({{ p.unit }})</span></div>
        <div :ref="set_host(p.key)" class="w-full overflow-hidden"></div>
      </div>

      <div v-if="stats" class="mt-6">
        <div class="font-semibold text-lg mb-2">구간 통계</div>
        <div class="flex flex-wrap gap-2 mb-3">
          <Tag severity="secondary" :value="`${stats.a.toFixed(2)} ~ ${stats.b.toFixed(2)}s (${stats.duration.toFixed(2)}초)`" />
          <Tag :severity="stats.over > 0.5 ? 'danger' : 'secondary'" :value="`합계 ${an.threshold}A 초과 ${stats.over.toFixed(2)}초`" />
          <Tag v-if="summary.em_frames" severity="secondary" :value="`에너지 EM ${n1(stats.em_energy_wh)} Wh`" />
          <Tag severity="secondary" :value="`에너지 ${summary.em_frames ? '컨트롤러 ' : ''}${n1(stats.energy_wh)} Wh`" />
          <Tag severity="secondary" :value="`거리 ${n1(stats.distance_km * 1000)} m`" />
        </div>
        <DataTable :value="stat_rows" size="small">
          <Column header="채널"><template #body="{data}">{{ data.c.label }}</template></Column>
          <Column header="최소"><template #body="{data}">{{ n1(data.s.min) }} {{ data.c.unit }} <span class="text-xs opacity-60">@{{ data.s.t_min.toFixed(2) }}s</span></template></Column>
          <Column header="최대"><template #body="{data}">{{ n1(data.s.max) }} {{ data.c.unit }} <span class="text-xs opacity-60">@{{ data.s.t_max.toFixed(2) }}s</span></template></Column>
          <Column header="평균"><template #body="{data}">{{ n1(data.s.mean) }} {{ data.c.unit }}</template></Column>
          <Column header="샘플"><template #body="{data}">{{ data.s.n.toLocaleString() }}</template></Column>
        </DataTable>
      </div>
    </div>
  </div>
</template>
