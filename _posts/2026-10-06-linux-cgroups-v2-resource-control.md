---
layout: post
title: "Linux cgroups v2로 자원을 제어하는 법: CPU·메모리·I/O·PIDs·systemd"
date: 2026-10-06 08:30:00 +0900
categories: [infrastructure]
tags: [infrastructure, linux, cgroups, cgroups-v2, systemd, containers, resource-control]
description: "Linux cgroups v2가 프로세스와 컨테이너의 CPU·메모리·I/O·프로세스 수를 제어하는 방식, systemd와의 관계, 운영 시 확인할 경계를 설명합니다."
---

한 서버에서 API, 배치, 모니터링, 데이터베이스, 컨테이너가 함께 실행되면 “누가 CPU와 메모리를 얼마나 써도 되는가?”는 단순한 튜닝 문제가 아닙니다. 한 배치가 메모리를 모두 가져가 API가 응답하지 못하거나, 잘못된 재시도 로직이 프로세스를 계속 만들어 서버의 PID(Process ID, 프로세스 식별자)를 고갈시키거나, 백업 작업의 디스크 I/O(Input/Output, 입출력)가 온라인 요청을 밀어내는 일이 생길 수 있습니다. **cgroups(control groups, 컨트롤 그룹)** 는 Linux 커널이 프로세스를 그룹으로 묶고 그 그룹의 자원 사용을 관찰·제어하도록 제공하는 기능입니다.

이 글의 대상인 **cgroups v2** 는 CPU, 메모리, I/O, 프로세스 수 같은 제어기를 하나의 통합 계층 구조에서 다루도록 설계된 cgroups 인터페이스입니다. Docker나 Kubernetes를 쓰면 직접 파일을 건드리지 않아도 이미 cgroups를 접하는 경우가 많습니다. 컨테이너의 메모리 제한, Kubernetes Pod의 CPU limit, systemd 서비스의 `MemoryMax=`는 결국 노드 Linux의 cgroups와 연결됩니다. 다만 cgroups는 자원을 ‘생성’하지 않고 경쟁을 조정할 뿐입니다. 잘못된 제한은 장애 전파를 막을 수도 있지만, 정상 요청을 스스로 죽이는 원인이 될 수도 있습니다.

<section class="quick-answers">
  <p class="quick-label">먼저 답하면</p>
  <div class="quick-answer"><h3>Q. cgroups는 컨테이너 전용 기능인가요?</h3><p>A. 아닙니다. 일반 Linux 프로세스와 systemd 서비스에도 적용됩니다. 컨테이너 런타임은 cgroups를 편리하게 쓰는 대표적인 사용자일 뿐이며, cgroups 자체는 Linux 커널 기능입니다.</p></div>
  <div class="quick-answer"><h3>Q. CPU·메모리 제한을 걸면 서버가 안전해지나요?</h3><p>A. 한 작업이 다른 작업을 삼키는 상황은 줄일 수 있지만, 너무 낮은 값은 CPU throttling, 메모리 회수 지연, cgroup OOM(Out Of Memory) 종료를 일으킬 수 있습니다. 워크로드 특성·관측 지표·복구 방식을 함께 설계해야 합니다.</p></div>
  <div class="quick-answer"><h3>Q. systemd를 쓰면 /sys/fs/cgroup 파일을 직접 수정해도 되나요?</h3><p>A. 보통은 권장하지 않습니다. systemd가 서비스의 cgroup 트리를 관리하는 경우 `systemctl set-property`나 unit drop-in처럼 systemd의 설정 경로를 써야 재시작·재배포 뒤에도 의도가 유지되고 관리 주체 충돌을 피할 수 있습니다.</p></div>
</section>

## 먼저 알아둘 기반 기술: 프로세스·커널·컨테이너·네임스페이스

**프로세스(process)** 는 실행 중인 프로그램의 단위입니다. 웹 서버를 실행하면 master와 worker 프로세스가 생길 수 있고, Java 애플리케이션은 JVM(Java Virtual Machine) 프로세스로 실행될 수 있습니다. Linux 커널은 프로세스마다 PID, 사용자·그룹, 열린 파일, 메모리, CPU 실행 시간 같은 상태를 관리합니다. `ps`, `top`, `htop` 같은 도구는 주로 개별 프로세스 관점에서 이 상태를 보여 줍니다.

**커널(kernel)** 은 응용 프로그램과 하드웨어 사이에서 CPU 스케줄링, 메모리 할당, 파일 시스템, 네트워크, 장치 접근을 조정하는 운영체제의 핵심입니다. 애플리케이션이 메모리를 요청한다고 해서 즉시 물리 메모리만 쓰는 것은 아닙니다. 가상 메모리, 페이지 캐시, reclaim(회수), swap, OOM 처리 같은 커널 정책이 관여합니다. 따라서 ‘애플리케이션 설정값’만 볼 것이 아니라 Linux가 실제 자원 경쟁을 어떻게 관리하는지 이해할 필요가 있습니다.

**컨테이너(container)** 는 가상 머신처럼 별도 커널을 갖는 것이 아니라, 한 Linux 커널 위에서 프로세스를 격리하고 실행하는 방식입니다. 컨테이너가 다른 프로세스와 분리돼 보이는 이유에는 여러 Linux 기능이 함께 쓰입니다. **네임스페이스(namespace)** 는 프로세스가 보는 PID, 네트워크 인터페이스, 마운트 지점, 사용자 등을 분리합니다. 반면 **cgroups** 는 프로세스 묶음이 쓰는 CPU·메모리·I/O·프로세스 수를 계량하고 제한하는 역할을 맡습니다. ‘보이는 세계를 나누는 것’이 namespace라면 ‘공유 자원을 어떻게 나눌지 정하는 것’이 cgroups라고 우선 구분해 두면 좋습니다.

**자원 제어(resource control)** 는 모든 작업에 같은 상한을 씌우는 행위가 아닙니다. 서비스별 중요도와 실패 방식을 정하는 일입니다. 고객 API는 지연이 길어지는 것보다 일정한 응답성을 원할 수 있고, 보고서 배치는 늦어져도 운영 트래픽을 방해하지 않는 것이 더 중요할 수 있습니다. 데이터베이스는 메모리 제한이 너무 낮으면 캐시 효율이 나빠지고, 너무 높으면 다른 서비스와 커널을 압박할 수 있습니다. cgroups 설정은 이런 우선순위를 커널이 집행할 수 있는 형태로 바꾸는 도구입니다.

## cgroups v2의 큰 그림: 하나의 트리에서 그룹을 관리한다

cgroups에는 오래된 v1과 통합 계층을 지향하는 v2가 있습니다. v1에서는 제어기별로 별도 계층이 생길 수 있어 CPU 그룹과 메모리 그룹의 구조가 달라지기도 했습니다. cgroups v2는 **unified hierarchy(통합 계층)** 를 중심으로 같은 프로세스 그룹 구조에서 여러 제어기를 다룰 수 있게 합니다. 실제 시스템의 부팅 방식·배포판·런타임 설정에 따라 v1, v2 또는 혼합 구성이 보일 수 있으므로, 먼저 자신의 노드를 확인하는 습관이 필요합니다.

다음 명령은 cgroup 파일 시스템 유형을 확인하는 간단한 출발점입니다.

```bash
stat -fc %T /sys/fs/cgroup
# cgroup2fs 라면 cgroups v2 통합 계층이 마운트된 상태를 뜻한다.
```

cgroup은 디렉터리처럼 보이는 트리입니다. 루트 cgroup 아래에 서비스, 사용자 세션, 컨테이너, 하위 작업 그룹이 놓일 수 있습니다. 프로세스는 한 cgroup에 소속되고, 부모·자식 그룹 관계를 통해 자원 정책이 전파되거나 분배됩니다. 예를 들어 `system.slice` 아래에 `api.service`와 `report.service`가 있고, `report.service` 아래에 여러 worker가 있다고 생각할 수 있습니다. 배치 worker를 API 서비스와 분리하면 배치가 과도하게 자원을 쓸 때 어디를 조정해야 하는지 경계가 명확해집니다.

```text
root cgroup
 ├─ system.slice
 │   ├─ api.service         ← 온라인 요청 처리
 │   ├─ report.service      ← 지연을 허용하는 배치
 │   └─ container-runtime.service
 │       └─ 컨테이너별 cgroup
 └─ user.slice
     └─ 로그인 사용자 세션
```

cgroups v2 문서에서 특히 중요한 원칙은 **단일 작성자(single-writer)** 와 **위임(delegation)** 입니다. 어떤 관리자가 한 cgroup 하위 트리를 관리하고 있는데 다른 관리자가 같은 범위를 임의로 수정하면, 서비스 재시작·컨테이너 생성·정책 갱신 때 서로의 설정을 덮어쓸 수 있습니다. systemd가 만든 서비스 cgroup은 systemd가, 컨테이너 런타임이 위임받은 하위 트리는 런타임이 관리하도록 역할을 나누는 이유가 여기에 있습니다. 직접 `/sys/fs/cgroup`를 수정하는 명령이 동작하더라도 지속 가능한 운영 방식인지 별도로 판단해야 합니다.

## CPU 제어: 비율과 상한은 다른 질문이다

CPU를 제어할 때는 먼저 ‘공정하게 나눌 것인가’와 ‘절대 사용량에 상한을 둘 것인가’를 구분해야 합니다. cgroups v2의 `cpu.weight`는 CPU가 부족해 경쟁할 때 그룹 사이의 상대적 비중을 표현합니다. 예를 들어 API와 보고서 배치가 모두 CPU를 많이 요구하는 상황에서 API의 weight를 더 높이면, 경쟁 상태에서 API에 더 많은 CPU 시간을 배분하도록 힌트를 줄 수 있습니다. CPU가 충분할 때는 weight만으로 사용을 강하게 막지 않습니다.

반면 `cpu.max`는 기간과 quota로 CPU 사용 상한을 설정합니다. systemd에서는 `CPUQuota=`가 이를 설정하는 대표적 인터페이스입니다. 다음은 가상의 보고서 서비스에 논리 CPU 1.5개 수준의 사용량 상한을 두고, 경쟁 상황의 상대적 중요도도 조정하는 예입니다.

```ini
# /etc/systemd/system/report.service.d/resources.conf
[Service]
CPUQuota=150%
CPUWeight=50
```

`CPUQuota=150%`는 하나의 CPU 코어가 100%라는 표현을 기준으로 150%의 실행 시간을 허용한다는 의미로 읽을 수 있습니다. 다만 실제 체감 성능은 노드의 CPU 개수, 스케줄러, 동시 실행 스레드, 다른 cgroup의 경쟁에 따라 달라집니다. 제한에 자주 닿으면 작업이 멈춘 것처럼 보일 수 있는데, 실제로는 CPU 시간이 **throttling(할당 기간 동안 실행을 늦춤)** 된 것일 수 있습니다. 이를 해결한다고 무조건 quota를 높이면 다른 서비스가 밀릴 수 있으므로, 처리량·대기열·응답 지연·CPU pressure를 함께 보고 결정해야 합니다.

CPU quota는 백그라운드 작업이 온라인 서비스를 잡아먹는 것을 막는 데 유용할 수 있지만, 지연에 민감한 서비스의 정상 부하를 과도하게 제한하면 꼬리 지연(tail latency)이 나빠질 수 있습니다. 요청량 급증 시 autoscaling, 작업 큐, 동시성 제한, 쿼리 최적화가 더 근본적인 해법일 때도 많습니다. cgroups는 병목 원인을 고치는 기능이 아니라 자원 피해 범위를 제한하는 기능이라는 점을 기억해야 합니다.

## 메모리 제어: 보호·완화·강제 종료의 경계를 읽는다

메모리 제어는 가장 조심해야 하는 부분입니다. 프로세스가 메모리를 많이 쓴다는 것은 heap만 커졌다는 뜻이 아닐 수 있습니다. 파일을 읽으며 쌓인 page cache, mmap, 공유 라이브러리, 자식 프로세스, 커널 메모리 등이 함께 보일 수 있습니다. cgroups v2의 메모리 파일은 현재 사용량, 보호 수준, high 경계, max 경계, 이벤트 등을 통해 그룹 단위의 상황을 관찰·제어합니다.

- `memory.current`는 현재 cgroup의 메모리 사용량을 관찰하는 값입니다.
- `memory.low`는 낮은 수준의 보호를 표현해, 전역 메모리 회수 상황에서 해당 그룹을 우선적으로 보호하려는 기준이 됩니다. 절대적인 보장은 아닙니다.
- `memory.high`는 강제 종료 이전에 압박과 회수를 유도하는 경계입니다. 넘는다고 즉시 프로세스를 죽이는 값은 아니지만, 성능 저하나 지연이 나타날 수 있습니다.
- `memory.max`는 강한 상한입니다. 더 이상 할당·회수가 불가능한 상황에서는 해당 cgroup 안에서 OOM 처리가 일어나 프로세스가 종료될 수 있습니다.

systemd의 `MemoryHigh=`와 `MemoryMax=`는 각각 이 개념과 연결해 설정할 수 있습니다. 예를 들어 일반적인 API 서비스에 아래처럼 설정할 수 있지만, 이 숫자는 예시일 뿐 실제 값은 부하·캐시·JVM·동시성·노드 여유 메모리를 측정한 뒤 정해야 합니다.

```ini
[Service]
MemoryHigh=2G
MemoryMax=3G
```

`MemoryHigh=`를 먼저 두는 이유는 상한을 넘었다는 사실을 너무 늦게 발견하지 않고, 회수 압박과 지연을 관찰할 기회를 얻기 위해서입니다. 그러나 high를 넘긴 상태를 오래 방치해도 괜찮다는 뜻은 아닙니다. 반대로 `MemoryMax=`만 아주 낮게 잡으면 노드 전체 OOM을 피하는 대신 서비스 프로세스를 반복 종료시키는 결과가 될 수 있습니다. 재시작 정책이 있다면 장애가 숨겨진 것처럼 보이고 요청 실패가 늘어날 수도 있습니다.

메모리 문제를 볼 때는 ‘호스트 전체가 OOM인가’와 ‘특정 cgroup이 max에 닿아 OOM 처리됐는가’를 구분해야 합니다. 후자는 cgroup의 이벤트와 system journal에서 단서를 찾을 수 있습니다. 서비스의 ControlGroup을 확인한 뒤, 해당 경로의 `memory.events`를 읽는 방식이 한 예입니다.

```bash
systemctl show api.service -p ControlGroup -p MemoryCurrent
systemctl status api.service
systemd-cgtop

# ControlGroup 경로를 확인한 다음 해당 cgroup에서 이벤트를 본다.
cat /sys/fs/cgroup/system.slice/api.service/memory.events
```

경로는 배포판·unit 이름·컨테이너 런타임에 따라 달라집니다. 그래서 문서의 예시 경로를 그대로 복사하기보다 `ControlGroup` 출력으로 실제 경로를 찾는 편이 안전합니다. `oom_kill` 같은 이벤트가 증가했다면 단순히 메모리를 높이기 전에, 왜 그 서비스가 그 순간 메모리를 많이 썼는지(입력 크기, 누수, 캐시, 동시성, 재시도 폭주)를 분석해야 합니다.

## I/O와 PIDs: 눈에 덜 보이지만 장애를 크게 만드는 자원

CPU와 메모리만 제한하면 충분하다고 생각하기 쉽지만, 디스크 I/O와 프로세스 수도 서버 전체에 큰 영향을 줍니다. 대량 로그 압축, 백업, 색인 생성, 임시 파일 정리는 스토리지 대기열을 길게 만들 수 있습니다. cgroups v2의 I/O 제어기는 장치별 가중치나 대역폭·IOPS(Input/Output Operations Per Second, 초당 입출력 작업 수) 제한 같은 정책을 표현할 수 있습니다. systemd의 `IOWeight=`, `IOReadBandwidthMax=`, `IOWriteBandwidthMax=`도 이 계층과 연결됩니다.

다만 I/O 제어는 스토리지 종류와 Linux I/O scheduler에 따라 기대한 만큼 보이지 않을 수 있습니다. 네트워크 스토리지, 가상화 계층, 장치 드라이버, 큐 구조가 중간에 있으면 제한이 어느 지점에서 적용되는지 확인해야 합니다. 따라서 “IOWeight를 낮췄으니 API 지연이 반드시 줄어든다”라고 단정하면 안 됩니다. 먼저 `iostat`이나 애플리케이션 지연·대기열 지표로 병목이 실제 디스크인지 확인하고, 테스트 환경에서 부작용을 확인해야 합니다.

**PIDs controller** 는 cgroup 안에서 만들 수 있는 프로세스·스레드 수를 제한합니다. 잘못된 fork loop, 실패한 작업을 무한히 재시작하는 스크립트, 스레드를 끝없이 생성하는 버그는 메모리뿐 아니라 PID 테이블과 스케줄러를 압박합니다. systemd의 `TasksMax=`는 서비스가 만들 수 있는 task의 상한을 두는 인터페이스입니다.

```ini
[Service]
TasksMax=512
```

512가 좋은 값이라는 뜻은 아닙니다. 웹 서버 worker, JVM thread pool, 자식 프로세스, 정상적인 peak 동시성을 먼저 파악하지 않고 상한을 걸면 정상 요청이 실패할 수 있습니다. 하지만 ‘무한 증식이 노드 전체를 멈추게 둘 것인가’와 ‘서비스 하나를 제한하고 빠르게 원인을 보게 할 것인가’ 사이에서 후자를 택해야 하는 워크로드도 있습니다. 상한은 알람·로그·재현 절차와 함께 두어야 원인을 감추지 않습니다.

## systemd와 cgroups: 서비스를 운영한다면 이 경로부터 쓴다

**systemd** 는 많은 Linux 배포판에서 부팅과 서비스 관리를 담당하는 init 시스템입니다. `systemctl start`, `systemctl restart`, `journalctl -u`로 서비스를 제어·조회할 때 systemd는 서비스 프로세스를 cgroup에 배치하고 slice·scope·service 단위의 자원 정책을 관리할 수 있습니다. 즉 cgroups를 배우는 것은 컨테이너 운영만이 아니라 Linux 서비스 운영과도 직접 연결됩니다.

용어를 간단히 구분하면, **service unit** 은 systemd가 장기 실행 프로세스를 관리하는 단위이고, **scope unit** 은 이미 실행 중인 외부 프로세스를 systemd가 묶어 관리할 때 쓰는 단위이며, **slice unit** 은 다른 unit을 계층으로 나누는 그룹입니다. 예를 들어 `system.slice` 아래에 일반 시스템 서비스를 두고, 부서별 또는 우선순위별 slice를 만들 수 있습니다. 모든 서비스를 하나의 slice에 두면 각 서비스의 사고가 서로에게 번질 여지가 커집니다.

기존 unit 파일을 직접 수정하기보다 drop-in을 만드는 방식은 패키지 업데이트와 설정을 분리하는 데 유리합니다.

```bash
sudo systemctl edit report.service
# 편집기에 [Service]와 CPUQuota= 등을 추가한다.
sudo systemctl daemon-reload
sudo systemctl restart report.service
sudo systemctl show report.service -p ControlGroup -p CPUQuotaPerSecUSec -p MemoryCurrent
```

실행 중인 서비스에 시험 적용이 필요하다면 `systemctl set-property`를 사용할 수 있습니다. 다만 영속성 여부와 재시작 시 동작을 명확히 확인해야 하며, 운영 변경은 기존 변경 관리 절차와 롤백 방법을 갖춰야 합니다. 자원 제한은 종종 정상 트래픽에서만 문제가 드러나므로, 설정을 바꾸기 전에 현재 baseline과 알람 기준을 남기는 일이 중요합니다.

## Docker와 Kubernetes에서 보이는 cgroups

Docker 명령의 `--memory`, `--cpus`, `--pids-limit` 같은 옵션은 컨테이너 프로세스가 속한 cgroup 정책으로 이어집니다. 컨테이너가 별도 운영체제처럼 보이더라도 호스트 커널의 cgroups를 함께 쓰므로, 컨테이너를 많이 올릴수록 노드 레벨 자원 계획이 필요합니다. 컨테이너에 메모리 제한이 없으면 한 컨테이너의 누수나 대량 요청이 노드 전체 메모리에 영향을 줄 수 있습니다. 반대로 무턱대고 낮은 memory limit을 주면 컨테이너가 OOM 종료돼 재시작을 반복할 수 있습니다.

Kubernetes에서는 Pod와 컨테이너의 `resources.requests`와 `resources.limits`가 자원 계획의 핵심 개념입니다. request는 스케줄러가 노드 배치를 판단할 때 참고하는 요청량이고, limit은 런타임에서 사용 상한과 연결되는 값입니다. 다만 “request는 곧 보장, limit은 언제나 정확한 속도”처럼 단순하게 이해하면 안 됩니다. Kubernetes 버전·cgroup driver·QoS(Quality of Service) 분류·노드 압박·런타임 구현에 따라 세부 동작이 달라질 수 있습니다. 운영자는 Pod YAML만 보지 말고 실제 노드에서 어떤 cgroup과 systemd 계층이 생겼는지, eviction과 OOM 신호가 어디서 나타나는지 함께 확인해야 합니다.

컨테이너 런타임과 systemd가 같은 cgroup 트리를 관리할 때도 단일 작성자 원칙은 그대로 중요합니다. Kubernetes가 만든 Pod cgroup을 운영자가 임의로 수정하면 다음 배포나 재시작에서 값이 사라지거나, 선언한 리소스 정책과 실제 상태가 달라질 수 있습니다. 컨테이너의 자원 제한은 Kubernetes manifest·Helm chart·플랫폼 정책처럼 선언의 원천에서 수정하고, 노드 서비스는 systemd unit에서 수정하는 식으로 관리 경계를 분리하는 편이 낫습니다.

## 가상의 운영 예시: 배치가 API를 밀어내는 상황

가상의 한 서버에서 `api.service`가 고객 요청을 처리하고, 새벽 보고서 작업이 `report.service`로 실행된다고 해 보겠습니다. 보고서는 큰 CSV를 읽고 압축 파일을 만들어 CPU와 디스크 I/O를 많이 씁니다. 평소에는 문제가 없지만, 새벽에도 글로벌 사용자의 API 요청이 들어와 보고서 실행 시간에 응답 지연이 늘어납니다.

첫 단계는 cgroups 값을 바로 넣는 것이 아니라 관측입니다. API p95/p99 지연, CPU 사용률, run queue, 디스크 대기, 메모리 압박, 보고서 처리량, 프로세스 수를 같은 시간축에서 봅니다. CPU가 포화이고 보고서 프로세스가 원인이라는 근거가 있다면 보고서에 `CPUWeight`를 낮추거나 `CPUQuota`를 시험 적용할 수 있습니다. 메모리 때문에 API가 죽는다면 보고서의 메모리 사용과 `memory.events`를 보고 `MemoryHigh`·`MemoryMax`를 검토할 수 있습니다. I/O가 병목이라면 저장장치와 scheduler의 특성을 확인한 뒤 I/O 제어가 실제로 적용되는 환경인지 실험해야 합니다.

이때 성공 기준을 “보고서 제한이 걸렸다”가 아니라 “API의 지연 목표를 지키면서 보고서 완료 시간이 허용 범위 안에 남았다”로 정해야 합니다. 보고서를 지나치게 조이면 작업이 아침 업무 시작 전 끝나지 않을 수 있고, API에만 자원을 몰아주면 백그라운드 적체가 누적될 수 있습니다. 제한값은 서비스 중요도·SLO(Service Level Objective, 목표 서비스 수준)·작업 마감 시간·노드 여유 자원을 함께 보고 결정하는 운영 정책입니다.

## 관찰과 문제 해결: 숫자 하나보다 사건의 흐름을 본다

cgroups를 운영하면 다음 질문에 답할 수 있어야 합니다. 어떤 프로세스가 어느 cgroup에 속하는가? 그 그룹의 현재 사용량과 제한은 무엇인가? 제한을 넘었을 때 throttle, reclaim, OOM, task 생성 실패 중 무엇이 일어났는가? 이 질문을 서비스 로그·system journal·노드 지표와 묶어 보아야 합니다.

`systemd-cgls`는 cgroup 트리를, `systemd-cgtop`은 그룹별 자원 사용을 살피는 출발점이 될 수 있습니다. `systemctl show`로 서비스의 ControlGroup과 자원 관련 속성을 보고, cgroup 파일의 `memory.current`, `memory.events`, `cpu.stat`, `pids.current` 등을 확인할 수 있습니다. 숫자를 읽을 때는 스냅샷 하나로 결론내리지 말고, 장애 전·중·후의 변화와 서비스 레벨 지표를 함께 비교해야 합니다.

```bash
systemd-cgls
systemd-cgtop
systemctl show api.service -p ControlGroup -p MemoryCurrent -p TasksCurrent
cat /sys/fs/cgroup/system.slice/api.service/cpu.stat
cat /sys/fs/cgroup/system.slice/api.service/pids.current
```

경로와 노출 파일은 시스템 구성에 따라 달라질 수 있습니다. 또한 권한 때문에 일부 파일을 읽지 못할 수 있습니다. 이런 경우 무리하게 권한을 넓히기보다, 운영용 모니터링 에이전트와 최소 권한 계정을 통해 필요한 지표를 수집하는 설계를 검토해야 합니다. 자원 제어 자체가 보안 경계를 약화시키면 안 됩니다.

## 적용 순서: 제한값부터 정하지 말고 경계와 관측부터 정한다

cgroups 도입에서 흔한 실수는 ‘서비스 하나에 메모리 2GB, CPU 1개’처럼 숫자부터 결정하는 것입니다. 그 숫자가 어떤 정상 부하에서 나온 것인지, 캐시 워밍업·배치·장애 재시도 때도 유지되는지 알지 못하면 제한은 보호 장치가 아니라 새로운 장애 조건이 됩니다. 가장 작은 안전한 순서는 **분류 → 관측 → 보호 우선순위 → 제한 시험 → 복구 검증** 입니다.

먼저 노드에서 어떤 프로세스가 어떤 서비스 단위로 운영되는지 분류합니다. 온라인 API, 비동기 worker, 배치, 모니터링, 데이터베이스, 컨테이너 런타임을 한 cgroup에 모두 넣으면 문제가 생겼을 때 책임 범위를 분리하기 어렵습니다. 이어서 평상시와 피크 시간의 CPU, 메모리, task 수, I/O 대기, 응답 시간, 처리량을 관찰합니다. 이 단계에서는 상한을 걸지 않아도 됩니다. ‘무엇이 정상인가’를 먼저 알아야 이상을 판별할 수 있습니다.

그다음 서비스 우선순위를 정합니다. 고객 요청 API는 지연 목표가 있고, 야간 보고서는 완료 마감이 있을 수 있으며, 모니터링은 노드 문제가 생겨도 살아 있어야 할 수 있습니다. 이 우선순위를 바탕으로 배치에 먼저 CPU weight 또는 quota를 시험하고, 메모리에는 `MemoryHigh=` 같은 완화 경계를 먼저 두어 압박 신호를 관찰할 수 있습니다. 강한 `MemoryMax=`와 `TasksMax=`는 예상치 못한 종료를 만들 수 있으므로, 알람·재시작 정책·롤백 방법을 확인한 뒤 단계적으로 적용하는 편이 안전합니다.

변경 후에는 제한값이 파일에 보인다는 사실만으로 성공을 선언하면 안 됩니다. 다음 질문에 답해야 합니다. 제한에 닿았을 때 API의 오류율과 지연은 어떻게 변했는가? 배치가 마감 전에 완료되는가? memory event와 system journal에 OOM 단서가 생기지 않았는가? 서비스 재시작이 반복되지 않는가? 제한을 해제하거나 이전 값으로 되돌리는 절차는 실제로 가능한가? 이 검증은 부하 테스트 환경에서 먼저 하고, 운영에서는 작은 범위·낮은 위험 서비스부터 적용하는 것이 좋습니다.

## cgroup 파일을 읽을 때 자주 생기는 오해

첫째, `memory.current`가 limit보다 낮다고 안전한 것은 아닙니다. 순간적인 할당 급증, 페이지 캐시 변화, 다른 cgroup과의 경쟁, 메모리 회수 속도 때문에 곧 high나 max에 닿을 수 있습니다. 시계열로 추세와 이벤트를 보는 이유입니다. 둘째, CPU 사용률이 낮아도 CPU 제한 문제가 없다는 뜻은 아닙니다. quota에 닿는 짧은 구간이 요청 지연을 만들 수 있고, 평균값은 이를 감출 수 있습니다. `cpu.stat`의 throttling 관련 값과 응답 지연을 함께 비교해야 합니다.

셋째, cgroup 경로가 보인다고 그 경로의 값을 누구나 수정해도 된다는 뜻은 아닙니다. systemd, Docker, Kubernetes, 사용자 세션 관리자가 각각 cgroup 계층을 만들 수 있습니다. 관리자가 재시작되면 수동 변경이 사라지거나 다른 선언과 충돌할 수 있습니다. 항상 해당 프로세스를 만든 상위 관리자의 공식 설정 경로를 찾는 것이 기본입니다. 예를 들어 systemd 서비스는 unit drop-in, Docker 컨테이너는 실행 옵션 또는 Compose 설정, Kubernetes 워크로드는 manifest의 resource 설정을 우선합니다.

넷째, 단일 노드의 cgroups는 클러스터 전체의 용량 계획을 대신하지 않습니다. Pod 하나의 CPU limit을 잘 설정해도 노드가 부족하면 스케줄링 대기와 eviction 문제가 생길 수 있고, 데이터베이스 I/O가 공유 스토리지를 포화시키면 다른 노드의 워크로드도 영향을 받을 수 있습니다. cgroups는 로컬 실행 경계를 다루는 계층이며, autoscaling, node pool 분리, 스토리지 품질, 네트워크 대역폭, DBMS 설정과 함께 봐야 합니다.

## 보안과 운영 책임: 제한도 권한을 가진 변경이다

자원 제한은 서비스 가용성에 직접 영향을 주므로 구성 파일 변경과 같은 수준의 검토가 필요합니다. 누가 `MemoryMax=`를 바꿀 수 있는지, 어떤 이유로 바꿨는지, 어떤 기준으로 되돌릴지 기록하지 않으면 장애 중에 설정이 계속 바뀌어 원인을 더 찾기 어려워집니다. 특히 여러 팀이 같은 노드를 공유한다면, 한 팀이 자신의 프로세스를 보호하려고 높은 weight·limit을 설정하는 것이 다른 팀 서비스의 성능 저하로 이어질 수 있습니다.

권한 모델도 중요합니다. cgroup 제어 파일에 쓰기 권한을 넓게 주면 일반 프로세스가 자신의 제한을 없애거나 다른 작업에 영향을 줄 가능성이 생깁니다. systemd의 위임 기능은 하위 트리를 관리할 필요가 있는 런타임에 필요한 범위만 넘기는 데 쓰이며, 무제한 권한 부여와 같은 뜻이 아닙니다. 컨테이너에 privileged 권한을 주거나 호스트 cgroup 경로를 무분별하게 마운트하는 방식은 편해 보여도 격리 목표를 약화시킬 수 있습니다.

운영 문서에는 적어도 서비스별 소유자, 자원 목표, 설정 원천, 알람 기준, 제한 초과 시 확인할 로그·명령, 롤백 명령을 남기는 편이 좋습니다. 이렇게 하면 새 담당자가 숫자의 의미를 추측하지 않고, 장애 시에도 ‘limit을 제거하자’ 같은 즉흥 대응 대신 정해진 순서로 상태를 확인할 수 있습니다. cgroups는 커널 기능이지만, 성공적인 사용은 기술 파일 몇 개보다 운영 책임의 명확성에 달려 있습니다.

제한을 적용한 뒤에는 정상 요청뿐 아니라 재시작, 배포, 일시적 부하 증가, 로그 폭증 같은 비정상 경로도 확인해야 합니다. 평상시에는 조용한 설정이 장애 순간에만 서비스의 복구를 방해할 수 있기 때문입니다. 자원 제어는 한 번 정한 숫자를 고정하는 작업이 아니라, 서비스 변화와 용량 계획에 맞춰 근거를 다시 확인하는 운영 항목입니다.

## 한계와 적용 기준 Q&A

### Q. cgroups를 쓰면 애플리케이션 성능 튜닝은 필요 없나요?

A. 필요합니다. 무한 재시도, 느린 SQL, 메모리 누수, 비효율적인 직렬화, 과도한 스레드 생성은 cgroups로 고쳐지지 않습니다. cgroups는 한 워크로드의 문제가 노드 전체로 퍼지는 범위를 줄일 수 있지만, 원인을 해결하는 대체 수단은 아닙니다. 제한에 계속 닿는다면 그 사실을 성능·용량·코드 문제의 신호로 삼아야 합니다.

### Q. 모든 서비스에 같은 CPU·메모리 제한을 걸면 관리가 쉬워지지 않나요?

A. 겉보기에는 단순하지만 위험합니다. 웹 API, 메시지 소비자, 데이터베이스, 모니터링, 백업은 정상적인 자원 사용 패턴이 다릅니다. 동일한 메모리 max는 어떤 서비스에는 너무 낮아 OOM을 만들고, 어떤 서비스에는 너무 높아 격리 효과가 없을 수 있습니다. 최소한 중요도, 피크 사용량, 복구 방식, 지연 허용 범위로 그룹을 나눈 뒤 단계적으로 적용하는 편이 낫습니다.

### Q. cgroups v1에서 v2로 바로 바꾸면 설정도 그대로 옮길 수 있나요?

A. 아닙니다. 계층 구조와 제어기 인터페이스가 다르고, systemd·컨테이너 런타임·배포판의 지원 상태도 확인해야 합니다. 단순 파일 이름 치환보다 현재 노드가 어떤 hierarchy를 쓰는지, 애플리케이션과 모니터링이 어떤 경로를 참조하는지, 롤백이 가능한지 검토해야 합니다. 전환은 테스트 노드와 점진 배포로 검증하는 것이 안전합니다.

### Q. 데이터베이스에도 cgroups 제한을 걸어도 되나요?

A. 가능 여부와 적절성은 별개입니다. 데이터베이스는 버퍼 캐시, 정렬·조인 메모리, 백그라운드 작업, I/O 특성이 있어 너무 낮은 제한이 성능 저하나 예기치 않은 종료로 이어질 수 있습니다. 같은 노드에서 다른 작업을 보호해야 한다면 DBMS의 자체 메모리·연결·작업 설정, 별도 노드 분리, 용량 계획을 먼저 검토하고 cgroups는 충분한 부하 검증과 롤백 계획 아래 적용해야 합니다.

## 마무리

cgroups v2는 Linux의 자원 경쟁을 서비스·컨테이너·작업 단위로 보이게 하고, CPU·메모리·I/O·프로세스 수에 운영 의도를 반영할 통로를 제공합니다. 그러나 상한 하나를 추가한다고 시스템이 자동으로 안정되는 것은 아닙니다. 어느 작업을 보호하고 어느 작업의 속도를 늦출지, 제한에 닿으면 어떤 신호를 보고 어떻게 복구할지, 누가 해당 cgroup 트리를 관리하는지를 먼저 정해야 합니다. systemd와 컨테이너 플랫폼의 선언적 설정을 우선하고, 관측 가능한 작은 범위에서 시험한 뒤 넓히는 접근이 cgroups를 안전하게 사용하는 출발점입니다.

<h3 class="references-heading">참고 자료</h3>

- [Linux Kernel documentation, Control Group v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)
- [systemd.resource-control(5), man7.org mirror](https://man7.org/linux/man-pages/man5/systemd.resource-control.5.html)
- [systemd, Control Group APIs and Delegation](https://systemd.io/CGROUP_DELEGATION/)
- [Docker Docs, Resource constraints](https://docs.docker.com/engine/containers/resource_constraints/)
- [Kubernetes Documentation, Resource Management for Pods and Containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
