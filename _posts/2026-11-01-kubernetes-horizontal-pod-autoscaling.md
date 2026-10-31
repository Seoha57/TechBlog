---
layout: post
title: "Kubernetes HPA를 설계하는 법: 메트릭·요청값·스케일링 지연·용량 경계"
category: Infrastructure
description: "Kubernetes Horizontal Pod Autoscaler가 메트릭을 바탕으로 replica 수를 조정하는 방식과 resource request, 지연, 병목, 안전한 운영 기준을 정리합니다."
---

<section class="quick-answers"><h2>먼저 답하기</h2><p><strong>Q. CPU 사용률만 기준으로 HPA를 켜면 트래픽 증가에 자동으로 대응되나요?</strong><br>A. 일부 workload에는 도움이 되지만, request 값·시작 시간·queue·database·외부 API·최대 replica·node 여유가 함께 맞아야 합니다. CPU는 하나의 신호일 뿐입니다.</p><p><strong>Q. HPA가 있으면 capacity planning은 필요 없나요?</strong><br>A. 필요합니다. HPA는 Pod 수를 원하는 만큼 즉시 만들 수 없으며, node 자원·cluster autoscaler·이미지 pull·의존성 용량·최대값의 경계를 넘을 수 없습니다.</p></section>

## 먼저 알아둘 기반 기술

Kubernetes Deployment는 Pod replica 수를 원하는 상태로 관리하고, scheduler는 각 Pod를 실행할 node를 찾습니다. HPA(Horizontal Pod Autoscaler)는 CPU·memory 또는 custom metric을 보고 target replica 수를 계산해 Deployment 같은 scale target의 replica 수를 조정합니다. 실제 Pod가 준비되고 traffic을 받기까지는 scheduler, image pull, startup, readiness probe가 추가로 필요합니다.

resource request는 scheduler가 Pod 배치에 사용하는 최소 자원 요청이고, limit는 container가 사용할 수 있는 상한입니다. CPU utilization 기반 HPA는 일반적으로 사용량을 request에 대한 비율로 해석하므로, request가 비현실적이면 scale 판단도 왜곡될 수 있습니다. request 없이 CPU target만 정하는 것은 측정 기준 없는 목표를 두는 것과 비슷합니다.

## HPA의 계산을 이해하기

HPA는 현재 replica 수와 관측한 metric, 목표값을 비교해 필요한 replica 수를 계산합니다. 단순화하면 현재 평균 CPU 사용률이 목표보다 높을수록 replica를 늘리고, 낮을수록 줄이려 합니다. 그러나 이 계산은 즉시 사용자를 보호하는 자동 스위치가 아닙니다. metrics pipeline이 값을 수집하는 시간, HPA controller가 다음 계산을 하는 시간, 새 Pod가 scheduler에 배치되는 시간, image를 내려받고 application이 시작해 readiness를 통과하는 시간이 모두 더해집니다.

트래픽 급증이 수십 초 안에 끝나는 경우 HPA가 새 Pod를 준비할 때는 이미 peak가 지나갔을 수 있습니다. 반대로 요청이 길게 쌓이는 workload에서는 CPU가 아직 낮아 보여도 queue depth와 response latency가 먼저 악화될 수 있습니다. 그래서 HPA의 목표 metric은 "가장 쉽게 볼 수 있는 수치"가 아니라, scale-out이 실제로 지연을 줄일 수 있는 병목 신호인지 기준으로 선택해야 합니다.

scale down도 신중해야 합니다. 트래픽이 잠시 줄었다고 Pod를 바로 줄이면 cache warm-up, connection 재생성, 다음 burst에서의 startup delay가 반복될 수 있습니다. Kubernetes HPA에는 stabilization window와 scaling behavior를 조정할 수 있는 기능이 있으며, workload의 요청 길이·traffic 주기·startup 시간에 맞게 변화 폭과 지연을 설계해야 합니다. 빠르게 늘리는 것과 천천히 줄이는 것은 흔한 출발점이지만, 실제 metric과 비용을 보고 조정해야 합니다.

## CPU·메모리·custom metric의 차이

CPU는 request 처리량과 비교적 직접적으로 연결되는 stateless web API에서 유용한 signal이 될 수 있습니다. CPU가 일정 수준을 넘으면 latency가 증가하고, Pod를 늘리면 요청을 나눠 처리할 수 있는 경우입니다. 하지만 CPU가 낮은데 외부 API timeout 때문에 요청이 대기하거나, database connection pool이 포화되어 thread가 block된 상황에서는 CPU 기반 HPA가 늦게 반응하거나 전혀 반응하지 않을 수 있습니다.

memory는 더 조심해서 해석해야 합니다. 메모리 사용량은 cache가 채워지는 정상 과정일 수도 있고, 큰 파일 처리·GC·memory leak·heap fragmentation의 신호일 수도 있습니다. Pod를 늘리면 cache가 여러 Pod에 다시 warm-up되어 총 memory가 늘 수 있고, leak이 있다면 모든 Pod가 결국 OOM될 수 있습니다. memory metric을 쓰더라도 OOM restart, working set, request size, cache hit ratio와 함께 보고 root cause를 확인해야 합니다.

custom metric은 queue length, 처리 대기 메시지 수, 초당 요청 수, active session, business backlog처럼 workload에 가까운 신호를 쓸 수 있게 합니다. 예를 들어 worker가 queue message를 처리하는 시스템이라면 CPU보다 "처리되지 않은 메시지 수와 각 worker의 안전한 처리량"이 replica 수 결정에 더 적합할 수 있습니다. 그러나 metric의 정의·수집 지연·누락·라벨 cardinality가 불안정하면 autoscaler가 잘못된 값으로 행동할 수 있습니다. custom metric은 business에 가깝다는 장점과 observability 의존성이 함께 있습니다.

## resource request가 중요한 이유

HPA에서 CPU utilization은 대개 실제 CPU 사용량을 request로 나눈 비율입니다. request를 지나치게 작게 잡으면 평소 사용량도 높은 utilization으로 보여 불필요하게 scale-out할 수 있습니다. 반대로 request를 너무 크게 잡으면 CPU가 실제로 포화에 가까워도 낮은 utilization으로 보여 scale-out이 늦어질 수 있습니다. request는 비용 청구용 숫자나 policy 통과용 값이 아니라 scheduler와 HPA가 workload를 이해하는 입력입니다.

request를 정할 때는 정상 부하, 예상 peak, startup과 warm-up, batch 작업, GC, sidecar 사용량을 분리해서 봅니다. p50 사용량만 보고 request를 잡으면 peak에서 node 배치와 HPA 반응이 불안정할 수 있고, 최고값만 보고 모든 Pod에 큰 request를 주면 bin packing이 나빠져 node 비용이 늘 수 있습니다. metrics를 일정 기간 관찰하고, Pod가 실제로 throttling·OOM·pending을 겪는지 확인하며 조정합니다.

limit도 HPA와 별개로 생각할 수 없습니다. CPU limit이 낮으면 application이 일을 더 처리할 수 있어도 throttling되어 latency가 늘 수 있고, HPA는 CPU utilization만 보고 새 Pod를 늦게 만들 수 있습니다. memory limit이 너무 낮으면 OOMKill과 restart가 반복될 수 있습니다. limit를 없애거나 크게 하는 선택은 cluster 멀티테넌시와 node 안정성에 영향을 주므로, workload·namespace·QoS 정책을 기준으로 platform 팀과 함께 정해야 합니다.

## 구체적 업무 예시: 이미지 변환 worker

사용자가 올린 이미지를 여러 크기로 변환하는 worker를 생각해 보겠습니다. worker는 queue에서 message를 받고 CPU를 많이 쓰며, 변환 결과를 object storage에 저장합니다. traffic이 몰리면 queue depth가 증가하고 처리 대기 시간이 길어집니다. 이 workload에서 web API처럼 request CPU만 보고 scale하면, queue가 이미 쌓였는데 active Pod의 CPU가 일시적으로 낮은 순간에 scale-out이 늦을 수 있습니다.

팀은 먼저 worker 하나가 안전하게 처리할 수 있는 동시 작업 수, 평균·긴 이미지의 처리 시간, object storage 지연, memory peak를 측정합니다. 그 뒤 queue depth를 worker 수로 나눈 backlog per Pod와 처리 지연을 custom metric으로 사용하고, CPU는 과도한 작업을 막는 보조 signal로 둡니다. 목표는 queue가 절대 0이 되는 것이 아니라, 사용자가 받아들일 수 있는 처리 시간 안에 backlog가 유지되는 것입니다.

HPA의 max replica를 크게 잡아도 node에 CPU와 memory가 없으면 Pod는 Pending 상태로 남습니다. 이때 cluster autoscaler가 node를 추가할 수 있는지, 새 node와 image pull이 얼마나 걸리는지, object storage와 queue가 늘어난 worker를 감당할 수 있는지도 확인합니다. worker 수만 늘려 database나 object storage를 과부하시키면 backlog는 줄지 않고 오류만 늘 수 있습니다. autoscaling은 한 컴포넌트의 숫자를 늘리는 것이 아니라 전체 처리 파이프라인의 용량을 맞추는 일입니다.

테스트에서는 갑작스러운 burst, 느린 object storage, poison message, worker crash, scale-down 중 작업 종료를 넣어 봅니다. 작업이 중간에 중단됐을 때 queue가 재처리하는지, 결과 파일이 중복 생성되지 않는지, idempotency key가 유지되는지 확인합니다. HPA가 정상적으로 replica를 늘렸다는 사실만으로 사용자 작업이 안전하게 완료됐다고 판단하지 않습니다.

## readiness와 startup 지연의 영향

새 Pod는 생성되자마자 traffic을 받지 않습니다. container image pull, dependency 초기화, configuration load, cache warm-up, readiness probe 성공이 필요합니다. HPA가 scale-out 결정을 내린 시점과 실제 capacity가 늘어나는 시점 사이가 길면, 짧은 burst나 급격한 incident에서 지연을 막기 어렵습니다. startup 시간을 trace와 metric으로 측정하고, 왜 긴지 분해해야 합니다.

image가 크거나 registry가 느리다면 image build와 distribution을 개선할 수 있습니다. application이 시작할 때 모든 데이터를 preload한다면 lazy loading, 별도 warm-up, cache 전략을 검토할 수 있습니다. readiness probe가 외부 dependency 전체를 기다리게 하면 provider 장애에서 새 Pod가 모두 unready가 될 수 있으므로, traffic을 받을 최소 조건과 부가 기능의 상태를 구분해야 합니다. 빠른 readiness를 위해 실제 요청을 처리할 수 없는 Pod를 traffic에 넣는 것도 위험합니다.

예상 가능한 traffic peak가 있다면 scheduled scaling이나 minimum replica 조정이 HPA 반응보다 실용적일 수 있습니다. 월말 정산, 정해진 이벤트, 업무 시작 시간처럼 수요가 반복되는 경우에는 peak 직전에 capacity를 준비하고, HPA는 예상 밖 변화에 대응하게 합니다. 이 선택은 과도한 상시 비용과 startup 지연의 trade-off이므로, peak의 크기와 실패 비용을 기준으로 결정합니다.

## HPA와 다른 autoscaler의 역할

HPA는 보통 Pod replica 수를 조정하지만, node가 부족하면 Cluster Autoscaler 같은 node level autoscaling이 필요할 수 있습니다. node autoscaling도 cloud provider quota, node group size, Pod request, daemonset overhead, scheduling constraint의 영향을 받습니다. HPA가 replica를 늘리고 cluster autoscaler가 node를 늘리는 두 단계의 지연을 함께 이해하지 않으면, dashboard에서 HPA가 정상인데 사용자 latency가 계속 높은 상황을 설명하기 어렵습니다.

VPA(Vertical Pod Autoscaler)는 Pod의 CPU·memory request 추천 또는 조정을 다루는 다른 도구입니다. HPA와 VPA를 같은 workload에 적용할 때는 request 변경이 HPA utilization 계산과 scheduling에 미치는 영향을 고려해야 합니다. 모든 autoscaler를 한꺼번에 켜는 것이 목표가 아니라, 어느 계층이 어떤 병목을 해결하는지 명확히 하는 것이 중요합니다. stateless API, long-running worker, stateful database, batch job은 같은 scaling 정책을 쓸 필요가 없습니다.

KEDA처럼 event-driven autoscaling 도구는 queue, stream, cloud event source에 따라 Pod 수를 조정하는 경우에 사용될 수 있습니다. 다만 event source metric의 정확성, authentication, scale-to-zero 뒤 첫 요청 지연, poison message 처리, max replica가 downstream에 미치는 영향을 함께 검증해야 합니다. autoscaler를 바꾸면 YAML만 바뀌는 것이 아니라 운영의 관찰 지표와 failure mode도 바뀝니다.

## scale-out이 해결하지 못하는 병목

Pod 수를 늘려도 database connection pool, third-party API quota, shared cache, single partition queue, global lock이 병목이라면 처리량은 늘지 않을 수 있습니다. 오히려 더 많은 Pod가 같은 dependency에 연결해 timeout과 retry를 늘릴 수 있습니다. HPA를 도입할 때 application의 병목이 CPU인지, network wait인지, downstream capacity인지 먼저 관찰해야 합니다. replica 그래프만 오르고 사용자 latency가 개선되지 않는 경우에는 autoscaler가 실패한 것이 아니라 잘못된 계층을 확장한 것일 수 있습니다.

database를 사용하는 API는 Pod 하나당 connection 수와 전체 connection 상한을 계산해야 합니다. HPA max replica를 50으로 두고 각 Pod가 20개 connection을 열면 database에 최대 1,000 connection이 필요할 수 있습니다. 실제 workload에는 sidecar, admin connection, batch job도 있으므로 여유가 더 필요합니다. connection pool size를 Pod 수와 독립적으로 크게 잡으면 scale-out이 database outage를 증폭할 수 있습니다. pool limit, queueing, timeout, backpressure를 HPA 설정과 같은 문서에서 검토하는 이유입니다.

외부 API도 마찬가지입니다. Pod를 늘리면 provider rate limit에 더 빨리 도달할 수 있고, 429 응답을 모든 Pod가 동시에 재시도하면 traffic이 폭증합니다. concurrency limit, token bucket, exponential backoff, circuit breaker, queue를 사용해 downstream 보호를 먼저 설계합니다. HPA는 내부 작업자를 늘리는 도구이지 외부 시스템의 처리 용량을 무한히 늘리는 도구가 아닙니다.

stateful workload는 수평 확장이 더 어렵습니다. session이 Pod 메모리에 있고 sticky session이 필요하거나, local disk에 상태가 있고, leader 하나만 작업할 수 있으면 replica를 늘려도 요청을 고르게 나누기 어렵습니다. session을 외부 store로 옮기거나, 작업을 partition하고, leader election과 shard ownership을 설계해야 할 수 있습니다. HPA를 켜기 전에 workload가 실제로 scale-out 가능한 구조인지 확인하는 것이 가장 값싼 검증입니다.

## 안정적인 scale 동작을 만드는 설정

HPA의 최소 replica와 최대 replica는 비용 설정이면서 가용성 설정입니다. minimum이 너무 낮으면 평소 traffic에서도 cold start와 cache warm-up을 반복하고, maximum이 너무 낮으면 peak에서 queue와 latency가 계속 증가합니다. maximum을 무조건 높이면 node·database·provider·예산 한계를 넘을 수 있습니다. 정상 traffic, 예상 peak, dependency capacity, node quota, 수동 대응 시간을 바탕으로 현실적인 범위를 정하고 정기적으로 다시 봅니다.

scale-up policy는 빠른 surge를 감당할 수 있어야 하지만, metric의 순간적인 spike나 오류로 replica가 과도하게 늘지 않도록 변화율을 제한할 수 있습니다. scale-down stabilization은 일시적인 traffic 하락 뒤 Pod를 너무 빨리 없애지 않도록 합니다. 정확한 값은 서비스마다 다르지만, 설정의 근거는 문서에 남겨야 합니다. "기본값이라서"라는 이유는 startup time이나 request duration이 다른 workload에서 안전한 근거가 되지 않습니다.

여러 metric을 사용할 때는 목표가 충돌할 수 있습니다. CPU는 낮지만 queue depth가 높거나, memory는 높지만 request rate는 낮을 수 있습니다. 각 metric이 어떤 위험을 대표하고, 어느 값이 replica 증가를 유도하며, 일시적 누락이 발생했을 때 어떤 동작을 기대하는지 정합니다. metric server나 custom metrics adapter가 실패할 때 HPA가 마지막 값을 유지하는지, alert가 발생하는지도 테스트해야 합니다.

## 관찰 지표와 경보

HPA 운영 dashboard에는 desired replica와 current replica뿐 아니라 metric target과 current value, Pod pending 수, readiness 통과 시간, CPU throttling, OOM restart, request latency, error rate, queue depth, node allocatable resource를 함께 봐야 합니다. desired replica가 올라가는데 current replica가 따라가지 못하면 scheduler나 node capacity 문제일 수 있고, current replica는 늘었는데 latency가 그대로면 dependency 병목일 수 있습니다. 하나의 panel만 보면 원인을 잘못 추측하기 쉽습니다.

경보는 autoscaler가 scale했다는 사실보다 사용자가 겪는 영향을 중심으로 만듭니다. p95·p99 latency, error rate, queue age, dropped request, saturation이 목표를 넘을 때 알리고, replica가 max에 도달했거나 Pod가 오래 pending일 때 원인 조사를 위한 보조 alert를 둘 수 있습니다. HPA가 정상 작동했다는 것은 사용자 SLO가 지켜졌다는 보장이 아닙니다.

capacity incident에서 runbook은 단순히 max replica를 올리라고 하지 않습니다. 현재 병목, node 여유, database connection, provider quota, 배포 이력, queue 상태를 확인하고 안전한 대응 순서를 제시해야 합니다. 무작정 Pod를 늘리는 action은 상황을 악화시킬 수 있습니다. 필요한 경우 traffic shed, feature degradation, batch 중지, rate limiting, 수동 scale 같은 대안을 포함합니다.

## 테스트와 실패 시나리오

HPA는 YAML이 적용됐다고 검증되는 기능이 아닙니다. load test나 controlled traffic으로 metric이 목표를 넘었을 때 desired replica가 증가하는지, 새 Pod가 readiness를 통과하는지, scale-down이 설정한 시간 뒤에만 일어나는지 확인합니다. 테스트 traffic은 실제 request 크기·dependency 호출·cache 상태와 너무 다르면 CPU와 latency 패턴도 달라질 수 있으므로, 대표적인 user flow를 사용합니다.

metric 누락도 테스트합니다. custom metrics adapter가 일시적으로 응답하지 않거나 label query가 잘못된 경우, HPA가 어떻게 보이는지, 운영자가 어떤 alert를 받는지 확인합니다. metric을 0으로 잘못 해석해 모든 Pod를 줄이는 일이 없도록 하고, fallback과 최소 replica가 안전한지 봅니다. 장애 상황에서 autoscaler의 동작을 이해하지 못하면 팀은 policy를 통째로 끄거나 수동 scale에 의존하게 됩니다.

scale-down 중 in-flight request와 background job을 처리하는 방식도 중요합니다. Pod termination 시 preStop hook, connection draining, graceful shutdown, queue acknowledgement가 맞지 않으면 처리 중인 요청이 실패하거나 같은 message가 두 번 실행될 수 있습니다. readiness를 먼저 false로 만들어 새 traffic을 멈추고, 정해진 grace period 안에 작업을 끝내거나 안전하게 재전달하는지 검증합니다. autoscaling은 Pod 생성만이 아니라 Pod 제거까지 포함합니다.

## 한계와 적용 기준 Q&A

### Q. HPA target을 낮게 잡으면 사용자 latency가 항상 좋아지나요?

A. 너무 낮은 target은 자주 scale-out해 비용과 downstream load를 늘릴 수 있고, startup 지연 때문에 짧은 burst에는 효과가 없을 수 있습니다. latency는 CPU 외에도 queue·network·database·application lock의 영향을 받습니다. target 값은 실제 SLO와 처리량·startup 시간을 관찰해 조정해야 합니다.

### Q. 최대 replica에 도달하면 무엇을 해야 하나요?

A. 먼저 node capacity와 dependency saturation, traffic pattern을 확인합니다. max를 단순히 올리기 전에 database connection·provider quota·queue·비용 한계를 검토해야 합니다. 필요하면 rate limit, 기능 저하, backlog 처리, cluster capacity 확장, architecture 개선 중 어떤 대응이 안전한지 선택합니다.

### Q. batch job에도 HPA를 쓰면 되나요?

A. long-running worker나 queue consumer에는 적합할 수 있지만, 완료되는 Job의 lifecycle과 retry·중복 처리·queue semantics를 고려해야 합니다. event-driven autoscaler나 job controller가 더 맞는 경우도 있습니다. Pod 수보다 업무 단위의 처리 완료와 정합성을 먼저 정의합니다.

## 도입 체크리스트

scale target이 실제로 stateless 또는 분할 가능한 workload인지 확인하고, CPU·memory·queue·request rate 중 병목을 가장 잘 드러내는 metric을 고릅니다. resource request와 limit, min·max replica, startup time, node capacity, downstream connection·quota를 함께 계산합니다. load·burst·metric 누락·scale-down·dependency 지연을 staging에서 검증하고, production에서는 canary와 SLO를 관찰합니다. dashboard와 runbook에는 HPA 상태뿐 아니라 사용자 latency와 backlog, pending Pod, dependency saturation을 포함합니다.

Kubernetes HPA는 traffic이 늘면 Pod 수를 자동으로 늘리는 편리한 기능이지만, 용량 계획을 없애는 기능은 아닙니다. 어떤 metric이 실제 병목을 나타내는지, 새 capacity가 언제 준비되는지, 늘어난 Pod가 downstream에 어떤 부담을 주는지 이해할 때 HPA는 비용과 가용성 사이에서 예측 가능한 도구가 됩니다.

## 비용과 탄소·용량의 trade-off

autoscaling은 idle capacity를 줄일 수 있지만, 항상 비용을 줄이는 것은 아닙니다. 낮은 CPU request와 aggressive scale-out은 더 많은 Pod와 node fragmentation을 만들 수 있고, 자주 scale down한 뒤 다시 warm-up하면 image pull과 cache miss 비용이 늘 수 있습니다. 반대로 minimum replica를 높게 두면 peak latency는 줄지만 평소 자원 비용은 증가합니다. 비용만 보는 운영과 latency만 보는 운영 모두 한쪽 위험을 숨깁니다.

팀은 사용자 SLO, workload priority, 예상 traffic, node utilization, downstream 비용을 함께 본 capacity budget을 정할 수 있습니다. production API는 여유 capacity를 두고, 지연 허용 가능한 batch는 queue를 이용해 비용이 낮은 시간에 처리할 수 있습니다. 이 구분은 HPA YAML 하나가 아니라 product의 서비스 수준 결정입니다. 비용 절감 실험은 error rate·latency·queue age가 악화되지 않는지 관찰하며 canary로 진행합니다.

cluster 전체 관점도 필요합니다. 여러 HPA workload가 동시에 peak를 맞으면 각 서비스는 target에 맞게 replica를 늘리려 하지만, node pool과 quota는 공유됩니다. priority class, resource quota, limit range, dedicated node pool이 없으면 중요하지 않은 workload가 capacity를 먼저 차지할 수 있습니다. HPA 설정을 팀마다 독립적으로 최적화하는 대신, platform dashboard에서 namespace·workload별 request와 peak behavior를 함께 봐야 합니다.

## 보안과 권한의 고려 사항

custom metric과 autoscaler는 metrics API, queue, cloud provider에 접근할 credential을 필요로 할 수 있습니다. HPA controller나 adapter가 필요한 것보다 넓은 cloud role·database credential을 갖지 않도록 service account와 workload identity를 분리합니다. metrics query가 tenant나 namespace 경계를 넘어서 데이터를 읽을 수 있다면, 다른 팀의 traffic·business 정보를 노출할 가능성도 있습니다. autoscaling은 성능 기능이지만 identity와 observability data를 다루는 보안 경계이기도 합니다.

scale target을 지정할 수 있는 RBAC도 검토합니다. 모든 개발자가 production Deployment의 min·max replica를 바꿀 수 있으면, 실수나 compromised CI가 capacity를 고갈시키거나 핵심 서비스를 줄일 수 있습니다. GitOps review, namespace role, policy guardrail, quota를 통해 어떤 변경이 허용되는지 정하고, 긴급 수동 scale은 ticket·audit·만료 조건을 남깁니다. 정상적인 autoscaling을 위해 broad admin 권한이 필요한 것은 아닙니다.

## 조직과 배포 흐름에 연결하기

HPA 변경은 application owner, platform team, database·external dependency owner가 함께 검토할 주제입니다. application owner는 처리량과 startup·shutdown 동작을, platform team은 node capacity·policy·metrics pipeline을, dependency owner는 connection·quota·backpressure 한계를 설명합니다. 이 정보를 한 release review에 연결하면 CPU target 하나가 다른 시스템을 과부하시키는 문제를 줄일 수 있습니다.

autoscaling 설정도 version control에 두고, 변경 이유·metric 정의·최소·최대 replica·예상 peak·rollback 방법을 PR에 남깁니다. production console에서 max replica를 급하게 바꾸는 일이 필요한 경우가 있어도, incident 뒤 repository 상태와 맞추고 왜 예외가 필요했는지 회고합니다. 선언된 desired state와 실제 cluster state가 다르면 다음 deploy에서 의도치 않게 다시 바뀔 수 있습니다.

HPA가 안정적으로 운영되면 새로운 서비스의 template에 안전한 기본값을 넣을 수 있습니다. 하지만 모든 서비스에 같은 CPU target과 replica 범위를 강제하지는 않습니다. request duration, statefulness, traffic pattern, dependency profile이 다른 workload에는 다른 계약이 필요합니다. template는 출발점이고, 측정과 test를 거친 service-specific 조정이 완성입니다.

## 장애 대응 시나리오로 HPA를 검증하기

실제 incident에서 HPA는 정상 metric을 보지 못하거나, 잘못된 metric을 따라갈 수 있습니다. metrics server가 늦어졌을 때, node가 부족해 Pod가 pending일 때, registry가 느려 image pull이 지연될 때, downstream database가 connection을 거절할 때 각각 어떤 dashboard와 alert가 원인을 구분하는지 확인합니다. 운영자가 desired replica만 보고 "autoscaler가 고장 났다"고 판단하면 근본 원인을 놓칠 수 있습니다.

traffic spike를 테스트할 때는 단순 request rate뿐 아니라 request mix를 포함합니다. 캐시 hit가 많은 가벼운 요청과 database를 오래 기다리는 요청, 큰 payload, 인증 실패, retry가 섞이면 같은 QPS라도 CPU·latency·queue 패턴이 달라집니다. 대표적인 사용자 흐름과 오류 흐름을 섞어 load test하고, 목표 SLO와 downstream saturation을 함께 관찰합니다. synthetic load가 실제 사용 패턴과 다르다는 한계도 결과에 기록합니다.

node drain이나 rolling update 중 HPA가 어떤 동작을 하는지도 중요합니다. 일부 Pod가 terminating이면 current replica 수가 있어도 실제 capacity는 줄 수 있고, 새 Pod가 다른 node에 배치될 때까지 latency가 증가할 수 있습니다. PodDisruptionBudget, readiness, graceful termination, surge 설정, HPA minimum의 조합을 staging에서 검증하고, maintenance window에서 max replica와 node 여유를 어떻게 조정할지 runbook에 남깁니다.

## 운영 수명 주기와 정기 검토

HPA 값은 한 번 정하면 끝나는 configuration이 아닙니다. application의 알고리즘, dependency version, cache policy, traffic 지역, base image startup time, node type이 바뀌면 기존 target과 min·max replica의 의미도 달라집니다. 주요 release, peak event, incident, 비용 급증 뒤에 HPA 설정과 실제 metric을 review합니다. 실제 peak에서 max replica에 도달하지 않았다고 해서 설정이 적절했다는 뜻은 아니며, latency와 backlog·dependency 상태를 같이 봅니다.

사용하지 않는 custom metric과 dashboard도 정리합니다. metric 정의가 바뀌었는데 adapter query는 옛 label을 보면 autoscaler가 조용히 잘못된 값을 받을 수 있습니다. owner와 source query, unit, expected range, alert, 변경 이력을 문서화하고, metrics pipeline의 permission과 retention도 점검합니다. autoscaling의 신뢰도는 controller보다 입력 데이터의 신뢰도에 크게 좌우됩니다.

## 마무리: 늘리는 것보다 제어하는 것

수평 확장은 부하를 나누는 강력한 방법이지만, application과 dependency의 한계를 없애지 않습니다. 좋은 HPA 설계는 CPU 값 하나를 정하는 일보다, workload가 scale 가능한지, 어떤 signal이 병목을 말해 주는지, 새 Pod가 언제 준비되는지, 최대치에서 어떤 사용자 경험을 제공할지 결정하는 일입니다. 이 질문을 metrics·load test·runbook·capacity plan에 연결하면 autoscaler는 예측 불가능한 자동화가 아니라 운영자가 이해하고 통제할 수 있는 도구가 됩니다.

## metric 정의의 품질을 보장하기

custom metric을 도입하면 metric 이름과 단위가 곧 autoscaling의 API contract가 됩니다. `queue_depth`가 전체 queue 수인지 특정 tenant를 제외한 수인지, `requests_per_second`가 성공·실패 요청을 모두 포함하는지, 데이터가 몇 초 지연되는지 명확히 해야 합니다. 같은 이름의 metric이 dashboard와 HPA query에서 다른 label filter를 쓰면 운영자는 서로 다른 숫자를 보고 잘못된 결론을 낼 수 있습니다.

metric에는 owner와 변경 절차가 필요합니다. application이 queue 이름이나 label을 바꾸면 adapter query와 autoscaler도 함께 바뀌어야 하고, metric이 더 이상 publish되지 않으면 HPA는 예상하지 못한 동작을 할 수 있습니다. CI 또는 staging check에서 metric query가 값을 반환하는지, unit이 예상한 범위인지, target selector가 올바른 workload를 가리키는지 검증하면 configuration drift를 일찍 발견할 수 있습니다.

비정상 값도 고려합니다. instrumentation bug로 backlog가 음수이거나 비정상적으로 큰 값을 내보내거나, scrape failure가 0처럼 보일 수 있습니다. autoscaler가 이런 값을 그대로 따라가면 급격한 scale-in 또는 scale-out이 일어날 수 있습니다. metric pipeline의 health alert, 최소 replica, 변화율 제한, 이상값 검증을 조합해 하나의 잘못된 수치가 capacity를 크게 바꾸지 않도록 합니다.

## SLO와 autoscaling의 연결

HPA target을 정할 때 "CPU 70%"만 기록하면 왜 그 값이 필요한지 시간이 지나며 사라집니다. 이 값이 p95 latency 500ms, queue age 30초, error budget 같은 어떤 서비스 목표를 지키기 위한 것인지 연결합니다. target을 조정한 뒤에는 CPU 값이 좋아졌는지보다 실제 SLO 위반 시간이 줄었는지 봅니다. 그렇지 않다면 metric이 병목을 잘 대표하지 못하거나 새로운 capacity가 너무 늦게 준비되는 것일 수 있습니다.

error budget이 빠르게 소진될 때 HPA는 여러 대응 중 하나입니다. autoscaler가 max에 도달했다면 traffic shedding, rate limit, cache 사용, 비필수 기능의 degrade, queued processing, 수동 capacity 확장 중 어느 방법이 사용자 영향과 데이터 정합성에 맞는지 정합니다. runbook에 이 순서를 적어 두면 on-call이 incident 중에 replica 하나만 계속 조정하는 대신 시스템 전체를 보고 대응할 수 있습니다.

## 플랫폼 팀과 application 팀의 계약

platform 팀은 metrics adapter, node pool, quota, policy, dashboard, 기본 HPA template를 제공할 수 있고, application 팀은 metric의 업무 의미, dependency 처리량, startup·shutdown 동작, peak event 정보를 제공합니다. 어느 한쪽만 알아서는 안전한 autoscaling을 만들기 어렵습니다. platform이 모든 service의 CPU target을 일괄 관리하면 workload 차이를 놓치고, application 팀이 node와 database 한계를 모르고 max replica를 늘리면 shared cluster의 위험을 키울 수 있습니다.

새 서비스 onboarding에는 HPA가 필요한지부터 질문합니다. 낮은 traffic의 internal tool은 manual replica가 더 단순할 수 있고, event worker는 queue 기반 scaling이 필요할 수 있으며, stateful database는 replica 증가보다 read replica·partition·query optimization이 필요할 수 있습니다. HPA는 좋은 기본 도구이지만 모든 workload에 붙여야 하는 체크박스는 아닙니다. 사용하지 않는 autoscaler는 설정 복잡성과 오해만 늘릴 수 있습니다.

이 계약을 문서와 dashboard로 유지하면 workload가 성장할수록 scaling 설정도 성숙합니다. peak와 incident 결과를 다음 capacity plan에 반영하고, 추가된 dependency와 metric을 review하며, 더 이상 맞지 않는 min·max와 target을 정리합니다. HPA를 운영한다는 것은 자동화된 숫자를 믿는 일이 아니라, 수요와 용량·사용자 경험 사이의 관계를 지속적으로 학습하는 일입니다.

## 도입 전후의 비교 기준

HPA를 새로 켤 때는 기준선을 먼저 수집합니다. 평소와 peak 시간의 replica 수, CPU·memory 사용량, request rate, p95·p99 latency, error rate, queue age, database connection, node utilization을 기록합니다. 기준선이 없으면 scale policy를 바꾼 뒤 좋아졌는지 나빠졌는지 판단하기 어렵습니다. 특히 traffic 자체가 변한 기간에는 이전 주나 유사한 workload와 비교해 해석해야 합니다.

도입 후에는 예상과 실제가 다른 지점을 찾습니다. 예상보다 scale-out이 늦다면 metric scrape, controller sync, scheduling, image pull, readiness 중 어느 구간이 긴지 분해합니다. replica는 충분한데 latency가 높다면 dependency saturation, lock, cache miss, GC, network를 봅니다. replica가 계속 변동한다면 target·stabilization·traffic 변동·metric noise를 확인합니다. autoscaler의 결과를 하나의 성공·실패로 판단하지 않고, capacity path의 관찰 가능한 실험으로 다룹니다.

## 용량 한계를 사용자 경험으로 연결하기

어떤 시스템도 무한한 traffic을 즉시 처리할 수 없습니다. HPA가 max replica에 도달했을 때 사용자가 기다릴지, 요청을 queue에 넣을지, 비필수 기능을 끌지, 명확한 재시도 안내를 받을지를 제품 수준에서 정해야 합니다. 이 결정이 없으면 인프라 팀은 Pod를 늘리고 application 팀은 retry를 늘리며, 사용자는 timeout만 보게 됩니다. graceful degradation은 autoscaling의 실패가 아니라 용량 한계에서 핵심 업무를 지키기 위한 설계입니다.

예를 들어 검색 추천이나 비동기 report 생성은 잠시 늦거나 간단한 결과를 제공할 수 있지만, 결제·권한 변경·데이터 저장은 요청을 조용히 drop해서는 안 됩니다. workload별로 queue·idempotency·status page·retry policy·manual escalation을 정하면, max capacity를 넘는 상황에서도 데이터 정합성과 사용자 신뢰를 지킬 수 있습니다. HPA는 이 계약의 한 요소이며, 최종 방어선은 아닙니다.

## HPA 설정을 읽을 때의 점검 순서

기존 HPA를 검토할 때는 먼저 scale target이 실제 Deployment 또는 StatefulSet과 맞는지, namespace와 label이 의도한 workload를 가리키는지 확인합니다. 다음으로 minimum·maximum replica와 CPU·memory request, metric target, behavior 설정을 읽고, 현재 replica·desired replica·최근 event를 봅니다. 설정 파일만 보고 판단하면 controller가 실제로 어떤 metric을 받고 어떤 이유로 scale을 하지 않았는지 놓칠 수 있습니다.

그 뒤 target Pod의 상태를 확인합니다. Pending Pod가 있다면 scheduler event와 node resource·taint·affinity·quota를 보고, Running이지만 unready라면 readiness probe·dependency·configuration을 봅니다. Pod가 ready인데 latency가 높다면 application metric과 downstream을 조사합니다. 이 순서는 HPA가 잘못됐다는 가정에서 시작하지 않고, capacity가 늘어나는 전체 경로를 따라가게 합니다.

변경은 한 번에 하나씩 적용합니다. CPU request와 target을 동시에 바꾸고 image를 새 버전으로 배포하면 결과 변화의 원인을 알기 어렵습니다. staging에서 하나의 parameter를 바꾸고 burst test·scale-up·scale-down·dependency 지연을 관찰한 뒤 production canary로 넘어갑니다. 긴급 변경이 필요했다면 incident 후에 configuration을 repository와 문서에 반영하고, 임시 max replica·bypass·수동 scale이 남아 있지 않은지 정리합니다.

## 최종 적용 기준

HPA가 적합한 workload는 수평으로 복제 가능하고, 요청 또는 작업이 Pod 간에 분배되며, metric이 처리량 또는 backlog와 의미 있게 연결되고, node와 dependency에 여유가 있는 경우입니다. 반대로 단일 leader·공유 local state·고정된 external quota·느린 startup·불명확한 metric이 있는 workload는 먼저 architecture 또는 observability를 개선해야 할 수 있습니다. autoscaling을 도입하지 않는 것도 정확한 기술적 결정이 될 수 있습니다.

안전한 시작은 작습니다. 한 서비스에 명확한 CPU 또는 queue metric, 보수적인 min·max, 충분한 request, dashboard와 alert, rollback 가능한 Git 변경을 준비합니다. 실제 traffic과 load test 결과를 보며 조정하고, max에 도달했을 때의 사용자 경험과 runbook을 확인합니다. 이 반복이 쌓이면 HPA는 단순한 자동 replica 조정에서, 서비스 신뢰성과 용량 계획을 연결하는 운영 도구로 자리 잡습니다.

운영 중에는 설정값의 정확성보다 변화 추세를 읽는 능력이 중요합니다. 같은 CPU target이라도 새 기능, cache 정책, node type, 외부 provider의 지연이 바뀌면 처리량과 latency의 관계가 달라집니다. peak 전후의 metric과 incident 기록을 비교하고, target·request·max replica를 정기적으로 재검토해야 합니다. 한 번의 성공적인 scale-out을 근거로 모든 미래 traffic을 처리할 수 있다고 가정하지 않는 것이 안정적인 autoscaling의 출발점입니다.

설정 변경은 한 번에 여러 값을 바꾸지 않는 편이 좋습니다. 예를 들어 CPU target과 request, max replica를 동시에 수정하면 latency가 개선되거나 악화된 이유를 구분하기 어렵습니다. 가설을 하나 정하고, 변경 전후의 traffic·queue·latency·error rate·Pending Pod를 같은 시간 창에서 비교합니다. autoscaler가 기대와 다르게 움직인다면 controller event, metrics API 응답, deployment rollout, node 여유를 순서대로 확인합니다. 이처럼 측정 가능한 작은 변경을 반복하면 HPA 설정은 문서의 숫자가 아니라 서비스 특성에 맞는 운영 지식이 됩니다.

## 한계와 적용 기준 Q&A

### Q. memory가 높으면 Pod를 늘리면 되나요?

A. memory 증가는 cache warm-up, memory leak, 큰 요청처럼 수평 확장으로 바로 해결되지 않는 원인도 있습니다. 새 Pod가 같은 메모리 문제를 반복할 수 있으므로 OOM, heap, request size, cache 정책을 먼저 분석해야 합니다.

<h3 class="references-heading">참고 자료</h3>

- [Kubernetes Documentation: Horizontal Pod Autoscaling](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
