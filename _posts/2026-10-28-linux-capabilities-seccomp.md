---
layout: post
title: "Linux 권한 격리를 설계하는 법: Root·Capability·seccomp·컨테이너 실행 경계"
date: 2026-10-28 08:30:00 +0900
category: Infrastructure
description: "Linux capability와 seccomp의 역할을 설명하고, 컨테이너·서비스의 최소 권한 실행과 장애 대응 기준을 정리합니다."
---

<section class="quick-answers"><h2>먼저 답하기</h2><p><strong>Q. 컨테이너에서 root로 실행하지 않으면 충분히 안전한가요?</strong><br>A. 아닙니다. 실행 사용자, Linux capability, syscall 허용 범위, 파일 권한, 네트워크, host mount를 함께 봐야 합니다. root를 없애는 것은 중요한 시작점이지만 전체 경계는 아닙니다.</p><p><strong>Q. seccomp는 성능 최적화 기능인가요?</strong><br>A. 주된 목적은 프로세스가 호출할 수 있는 system call을 제한해 공격 표면을 줄이는 것입니다. 잘못된 규칙은 정상 동작을 막을 수 있으므로, 필요한 호출을 관찰하고 단계적으로 적용해야 합니다.</p></section>

Linux 서비스가 침해되었을 때 피해 범위는 취약점 자체만으로 결정되지 않습니다. 프로세스가 root인지, 어떤 파일을 읽고 쓸 수 있는지, host의 장치나 socket에 접근할 수 있는지, 어떤 kernel 기능을 호출할 수 있는지에 따라 같은 취약점의 결과가 달라집니다. 최소 권한 원칙은 “아무 권한도 주지 말자”가 아니라 서비스가 업무를 수행하는 데 필요한 권한만 주고 나머지는 제거하자는 운영 원칙입니다.

컨테이너는 프로세스를 격리하는 유용한 단위지만, 컨테이너 안에서 실행된 코드도 결국 Linux kernel의 system call을 사용합니다. 따라서 image가 작고 Pod가 별도 namespace에 있다고 해서 자동으로 안전한 것은 아닙니다. 이 글은 root·capability·seccomp를 각각 어떤 경계로 보아야 하는지, Kubernetes와 systemd 환경에서 어떻게 검증할 수 있는지 설명합니다.

## 먼저 알아둘 기반 기술

Linux에서 사용자 ID(UID)는 프로세스가 어떤 사용자 권한으로 동작하는지를 나타냅니다. UID 0은 전통적으로 root이며 많은 관리 작업을 수행할 수 있습니다. 그러나 root와 일반 사용자만으로 모든 권한을 표현하면, 네트워크 설정처럼 한 가지 관리 기능이 필요한 프로그램에 전체 관리 권한을 주게 됩니다. Linux capability는 root 권한의 일부를 작은 권한 조각으로 나눈 메커니즘입니다.

system call은 사용자 프로그램이 kernel에 파일 열기, 네트워크 연결, 프로세스 생성, 메모리 처리 같은 작업을 요청하는 인터페이스입니다. seccomp(secure computing)는 프로세스가 어떤 system call을 호출할 수 있는지 정책으로 제한하는 기능입니다. policy가 허용하지 않은 호출은 거절하거나 process를 종료하도록 할 수 있습니다. 따라서 seccomp는 application bug를 고치는 기능이 아니라, bug가 kernel 기능까지 확장될 수 있는 범위를 줄이는 방어층입니다.

namespace는 프로세스가 PID, network interface, mount, user 등의 자원을 다른 프로세스와 분리해 보게 하는 Linux 기능입니다. cgroup은 CPU·메모리·I/O 같은 자원 사용을 제어합니다. 컨테이너 runtime은 namespace·cgroup·filesystem·capability·seccomp를 조합해 격리 환경을 만듭니다. 각 기능은 서로를 대체하지 않으므로, 하나가 있다고 다른 위험을 무시하면 안 됩니다.

## Root로 실행할 때 생기는 문제

root 프로세스는 container 내부에서만 root일 수 있지만, 잘못된 mount나 privileged 설정이 있으면 host 자원으로 영향이 넓어질 수 있습니다. 또한 image의 package manager, shell, debug tool, writable directory가 많을수록 침해 후 공격자가 할 수 있는 일이 늘어납니다. root를 피하는 목적은 단순 규칙 준수가 아니라, 애플리케이션 취약점이 파일 변조·포트 바인딩·권한 변경으로 이어지는 범위를 줄이는 데 있습니다.

non-root user로 실행하려면 image build 단계에서 실행 사용자와 파일 소유권을 맞춰야 합니다. 애플리케이션이 log, cache, upload directory에 쓸 수 있어야 하고, 1024 미만 port를 직접 열어야 하는지, 시작 script가 root 권한을 가정하는지 확인해야 합니다. 권한 오류가 난다고 runtime에서 root로 돌려 문제를 숨기기보다, 필요한 디렉터리와 port 구조를 명시적으로 바꾸는 편이 안전합니다.

Kubernetes에서는 `runAsNonRoot`, `runAsUser`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation` 같은 securityContext 설정을 조합할 수 있습니다. 하지만 YAML에 값을 넣었다고 끝나지 않습니다. 실제 image의 USER, entrypoint, volume mount 권한, init container가 만든 파일, application의 임시 파일 경로를 함께 테스트해야 합니다. 배포 뒤에는 process UID와 쓰기 가능한 경로가 기대와 맞는지 확인합니다.

## Capability를 필요한 만큼만 주기

capability는 `CAP_NET_BIND_SERVICE`, `CAP_NET_RAW`, `CAP_SYS_ADMIN`처럼 특정 kernel 작업을 허용하는 권한 집합입니다. 예를 들어 낮은 port에 bind해야 하는 서비스가 있을 수 있지만, 그렇다고 모든 관리 capability가 필요한 것은 아닙니다. 컨테이너 runtime의 기본 capability와 application 요구를 비교하고, 필요하지 않은 capability는 drop하는 방식으로 공격 표면을 줄일 수 있습니다.

특히 이름에 ADMIN이 들어간 capability는 범위가 넓을 수 있으므로 이유 없이 추가하면 안 됩니다. 운영 중 “권한 부족” 오류를 해결하려고 capability를 하나씩 넓혀 가면, 나중에는 왜 필요한지 아무도 설명하지 못하는 권한 세트가 됩니다. 어떤 binary가 어떤 업무에서 어떤 kernel 작업을 하려는지, 더 낮은 권한의 설계나 별도 privileged helper로 분리할 수 있는지 먼저 봅니다.

capability를 모두 drop한 뒤 필요한 항목만 add하는 방식은 의도를 읽기 쉽습니다. 그러나 모든 workload에 같은 policy를 강제하면 node exporter, CNI, storage plugin처럼 특수 권한이 필요한 component가 깨질 수 있습니다. workload 종류와 위험도를 분류하고, 예외는 namespace·service account·승인 절차·정기 검토와 함께 관리해야 합니다.

```yaml
securityContext:
  runAsNonRoot: true
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
  readOnlyRootFilesystem: true
```

이 예시는 일반 웹 서비스의 출발점일 수 있지만, 모든 환경의 완성된 정답은 아닙니다. application이 `/tmp`에 써야 한다면 빈 `emptyDir` 같은 명시적 writable volume을 주고, 필요한 port·certificate·cache가 어떤 권한을 요구하는지 테스트합니다.

## seccomp는 syscall 허용 목록이다

seccomp filter는 process architecture와 system call 번호를 기준으로 허용·거절·감사 동작을 정합니다. modern container runtime은 일반 workload에 쓸 수 있는 기본 profile을 제공할 수 있으며, 이 profile은 위험도가 높은 일부 syscall을 제한합니다. 기본 profile을 적용하는 것부터 시작하면 직접 수백 개 syscall을 관리하는 부담을 줄일 수 있습니다.

custom profile은 매우 강력하지만 운영 난이도도 높습니다. application library, runtime, thread, DNS resolver, language VM이 어떤 syscall을 쓰는지 버전과 workload에 따라 달라질 수 있습니다. 개발 환경에서 정상 요청만 통과했다고 production의 background job, error path, certificate reload도 통과한다는 보장은 없습니다. audit 또는 로그를 통해 거절된 호출을 관찰하고, 왜 필요한지 확인한 뒤 최소한으로 허용해야 합니다.

seccomp 거절은 보통 애플리케이션 오류처럼 보일 수 있습니다. process 종료, `Operation not permitted`, 특정 기능만 실패하는 증상이 나타날 수 있으므로, 배포 시 profile 버전과 적용 범위를 기록하고 rollback 방법을 둡니다. 무조건 profile을 `Unconfined`로 풀어 장애를 해결하면 보호층을 잃습니다. 먼저 어떤 syscall이 왜 거절됐는지, 코드·라이브러리 업데이트로 대체할 수 없는지 조사하세요.

## 구체적 업무 예시: 파일 업로드 API

파일 업로드 API는 사용자가 보낸 데이터를 임시 디렉터리에 저장하고 바이러스 검사 또는 변환 worker에 전달할 수 있습니다. 이 서비스는 writable storage가 필요하지만 root filesystem 전체에 쓸 필요는 없고, host의 Docker socket이나 raw network 권한도 필요하지 않을 수 있습니다. image를 non-root로 실행하고 root filesystem을 read-only로 두며, 업로드 임시 경로에만 권한이 있는 volume을 제공하는 식으로 경계를 만듭니다.

QA는 정상 업로드·큰 파일 거절·잘못된 MIME type·변환 실패·pod 재시작·디스크 부족을 테스트합니다. 그 과정에서 application이 예상하지 않은 경로에 쓰거나, permission 오류를 500으로 숨기거나, seccomp 때문에 변환 subprocess가 실패하지 않는지 확인합니다. 보안 설정은 보통 성공 경로에서는 보이지 않으므로, 실패 경로와 운영 도구 동작까지 포함한 검증이 필요합니다.

운영자는 upload ID, 사용자 조직, 파일 크기, 변환 상태, 오류 유형을 로그로 연결하되 파일 본문과 비밀 정보를 로그에 남기지 않습니다. securityContext 변경 뒤 실패율이 늘었다면 어떤 파일 형식·worker·node에서 시작됐는지 좁히고, 권한을 넓히기 전에 volume mount와 application path를 확인합니다.

## systemd 서비스에도 적용하기

컨테이너가 아닌 Linux service도 systemd sandbox 설정으로 일부 경계를 줄일 수 있습니다. `User=`, `NoNewPrivileges=`, `ProtectSystem=`, `PrivateTmp=` 같은 옵션은 서비스가 누구로 실행되고 어떤 filesystem·임시 영역을 보는지 제한하는 데 도움을 줍니다. 다만 option 이름만 복사하면 backup, log rotation, socket activation, certificate reload가 깨질 수 있으므로 서비스의 실제 파일·network·process 요구를 먼저 목록화해야 합니다.

systemd hardening은 capability·seccomp와 마찬가지로 단계적 적용이 좋습니다. staging에서 시작·중지·reload·오류 복구·배치 작업을 확인하고, journal에 나온 permission 오류를 업무 요구와 비교합니다. 서비스가 `/etc`를 쓴다고 해서 전체 filesystem protection을 끄기보다 설정 생성 책임을 deploy 단계로 옮기거나 필요한 경로만 ReadWritePaths로 허용하는 방식을 검토합니다.

## 정책과 예외를 운영하는 법

기본 policy는 대부분의 일반 API와 worker에 적용하고, privileged workload는 별도 목록으로 관리합니다. admission policy 또는 CI 검사로 root 실행, privileged mode, hostPath mount, `CAP_SYS_ADMIN`, seccomp 미적용을 감지할 수 있습니다. 하지만 경고가 너무 많으면 팀이 예외를 무시하게 되므로, 위험도가 큰 규칙부터 시행하고 예외에는 소유자·업무 이유·만료 또는 재검토 날짜를 붙입니다.

정책 변경은 application team과 platform team의 협업입니다. platform team은 안전한 기본값과 검증 도구를 제공하고, application team은 실제 필요 권한과 테스트 결과를 설명합니다. 어느 쪽도 모든 workload의 내부 동작을 혼자 알 수 없으므로, 실패 로그·manifest·배포 이력을 연결해 대화할 수 있어야 합니다.

## 이미지·공급망과 함께 보는 이유

runtime 권한을 줄여도 image 안에 취약한 library, 불필요한 shell, 오래된 package가 많으면 공격 표면은 남습니다. base image를 필요한 runtime 중심으로 작게 유지하고, dependency 업데이트·취약점 점검·image digest 고정·SBOM 확인을 함께 수행해야 합니다. capability와 seccomp는 실행 뒤의 피해 범위를 줄이는 방어층이고, image 관리는 취약한 코드를 production에 넣지 않기 위한 다른 방어층입니다.

CI에서 image를 build할 때 non-root USER가 선언됐는지, package manager cache가 남지 않았는지, secret이 layer에 들어가지 않았는지 확인할 수 있습니다. 그러나 정적 검사만 통과해도 runtime에서 volume 소유권, certificate 경로, temporary file이 달라질 수 있습니다. build 단계 검사와 staging 실행 검증을 모두 두는 이유입니다.

## 장애 조사와 롤백

권한 hardening 배포 뒤 오류가 나면 먼저 영향 받는 endpoint와 process UID, mount, denied syscall·capability 메시지를 확인합니다. 다음으로 application 설정·volume 경로·library 요구를 점검하고, 최소 예외로 해결 가능한지 판단합니다. 전체 privileged mode로 전환하는 것은 빠른 복구처럼 보여도 더 넓은 위험을 만들 수 있습니다. 꼭 rollback해야 한다면 어떤 경계를 일시적으로 풀었는지, 언제 다시 검토할지 기록합니다.

보안 설정 변경도 feature 변경처럼 작은 범위에서 배포하고 관찰합니다. 일부 workload에서 `readOnlyRootFilesystem`을 먼저 적용해 오류율·restart·permission denied 로그를 보고, 필요한 writable path를 좁혀 추가한 뒤 범위를 넓힙니다. 정책이 실패한 이유를 데이터로 남기면 다음 서비스는 더 빠르게 최소 권한 구성을 만들 수 있습니다.

## Kubernetes 정책 검증

Kubernetes에서는 개별 manifest의 securityContext가 있어도 namespace마다 적용 수준이 다르면 정책이 흔들릴 수 있습니다. admission control이나 policy-as-code로 privileged, host network, host PID, hostPath, root 실행, capability 추가, seccomp 미지정을 검토하면 배포 전 위험한 기본값을 발견할 수 있습니다. 다만 정책은 service account, namespace, 운영 component의 예외까지 고려해야 하므로, 거절 메시지와 예외 절차를 함께 설계해야 합니다.

CI 검사는 manifest를 정적으로 읽어 명백한 누락을 찾고, staging 검증은 실제 runtime의 UID·filesystem·syscall 문제를 찾습니다. 둘 중 하나만으로는 부족합니다. policy가 새 image나 chart update를 막았을 때는 이유 없는 우회 annotation을 추가하기보다, 요구 권한·소유자·만료 시점을 기록한 예외인지 확인해야 합니다.

## 적용 판단 기준

일반 HTTP API, batch worker, document processor는 non-root·read-only root filesystem·기본 seccomp·capability drop을 기본 후보로 볼 수 있습니다. 반면 network plugin, storage driver, observability agent, hardware device workload는 특별 권한이 필요할 수 있습니다. 중요한 것은 예외가 있다는 이유로 기본을 포기하지 않는 것입니다. 위험도가 다른 workload를 같은 rule로 몰아넣기보다, 안전한 기본군과 검토된 예외군을 구분하세요.

권한 격리의 성과는 설정 수가 아니라 침해나 오류가 났을 때 프로세스가 할 수 없는 행동이 명확해졌는지로 판단합니다. 서비스 소유자는 필요한 파일·포트·system call을 설명할 수 있어야 하고, 운영자는 그 설명을 manifest·로그·테스트로 확인할 수 있어야 합니다.

## 테스트 매트릭스와 문서화

권한 설정은 정상 요청 하나만으로 검증되지 않습니다. 서비스 시작·종료·reload, 파일 쓰기·읽기, 인증서 갱신, DNS 조회, outbound 연결, worker subprocess, 장애 후 재시작을 나누어 확인합니다. 각 시나리오에서 기대한 동작과 거절되어야 할 동작을 함께 적으면, 정책이 느슨해졌는지 과도하게 좁아졌는지 구분하기 쉽습니다. 예를 들어 upload API는 지정한 temporary volume에는 쓰지만 application image의 설정 경로에는 쓰지 못해야 할 수 있습니다.

권한 목록은 운영 문서에도 남깁니다. 어떤 service account가 어떤 volume을 mount하는지, capability 예외가 왜 필요한지, seccomp profile은 어느 image 버전에서 검증됐는지 기록하면 incident 때 설정을 추측하지 않아도 됩니다. 문서는 거대한 보안 보고서가 아니라 다음 변경자가 위험한 예외를 재검토할 수 있는 짧은 근거면 충분합니다.

## 관찰 지표와 정기 점검

security hardening은 배포 직후만 보는 작업이 아닙니다. permission denied, seccomp deny, privileged workload 수, root 실행 image 수, 예외 policy 수를 추세로 보고, 새 chart·runtime·OS update 뒤 변화를 확인합니다. 수치가 늘었다고 항상 위험한 것은 아니지만, 예외가 늘거나 기본 profile이 빠지는 패턴은 정책이 우회되고 있다는 신호일 수 있습니다.

정기 점검에서는 더 이상 쓰지 않는 capability와 host mount를 제거하고, 예외 소유자가 아직 존재하는지 확인합니다. 서비스가 변경되면서 원래 필요했던 권한이 사라질 수 있기 때문입니다. 제거 전에는 staging에서 정상 동작을 확인하고, rollback 가능한 manifest를 준비합니다.

## 파일 시스템과 secret 경계

read-only root filesystem을 적용해도 secret volume과 writable data volume의 mount 위치가 넓으면 민감한 값이 다른 process에 노출될 수 있습니다. certificate·token·configuration은 필요한 container와 경로에만 mount하고, application이 읽기만 하면 되는 파일은 write permission을 주지 않습니다. 임시 파일과 영속 데이터는 별도 volume으로 분리해 삭제·백업·권한 정책을 다르게 적용합니다.

로그에도 동일한 원칙이 필요합니다. 권한 오류를 조사하려고 환경 변수·command line·secret 경로의 내용을 그대로 출력하면 방어 설정이 다른 유출 경로가 됩니다. 오류에는 process ID, operation, 안전한 경로 분류, deny reason을 남기고, 실제 secret 값은 출력하지 않습니다.

## User namespace와 rootless 실행을 구분하기

컨테이너 안에서 `uid 0`으로 보이는 사용자가 host의 root와 같은 권한을 갖는지는 user namespace 설정에 따라 달라집니다. user namespace는 컨테이너의 사용자 ID를 host의 다른, 권한이 낮은 ID 범위에 매핑할 수 있게 하는 Linux 기능입니다. 이 경우 컨테이너 안의 root는 파일 소유권을 관리하는 데 필요한 일부 권한을 가질 수 있어도 host 전체를 관리하는 root와 동일하지 않습니다. rootless container runtime은 이 원리를 이용해 runtime 자체도 일반 사용자로 실행하려는 방식입니다.

다만 rootless라는 단어만 보고 host 접근 위험이 사라졌다고 판단하면 안 됩니다. bind mount한 host 경로의 권한, daemon socket 노출, 추가 device, namespace를 공유하는 설정, kernel 취약점은 별도로 검토해야 합니다. 예를 들어 개발 환경에서 Docker socket을 컨테이너에 mount하면 application process가 socket을 통해 새 privileged container를 만들 수 있는지가 더 중요한 문제가 됩니다. 사용자를 바꾼 사실보다 실제로 닿을 수 있는 host API와 파일을 목록으로 확인해야 합니다.

업무에서는 production service를 바로 rootless로 바꾸기보다, 먼저 image가 특정 root 전용 경로를 쓰는지 확인합니다. package manager cache, `/var/run` socket, 1024 미만 port, log directory처럼 관습적으로 root가 쓰던 위치가 자주 막힙니다. 쓰기 경로를 application 전용 volume으로 옮기고 high port 뒤에 ingress나 proxy를 두면 해결되는 경우가 많습니다. 꼭 필요한 system 기능이라면 sidecar·host service처럼 책임을 분리하는 편이, application 전체에 강한 권한을 돌려주는 것보다 변경 이유를 설명하기 쉽습니다.

## 네트워크와 host API도 권한의 일부다

Linux capability와 seccomp는 process가 kernel에 할 수 있는 일을 줄이지만, 네트워크 연결 자체가 넓으면 공격자는 외부 service나 내부 관리 API를 이용할 수 있습니다. 따라서 실행 권한 설계에는 inbound port뿐 아니라 outbound 목적지도 포함합니다. image를 내려받는 build 단계, application이 database·message broker·identity provider에 연결하는 실행 단계, 운영자가 관리 endpoint에 접속하는 관리 단계를 구분해야 합니다.

가령 주문 API가 database와 결제 provider만 호출해야 한다면, 모든 사내 CIDR로 나가는 egress를 기본값으로 두기보다 필요한 DNS 이름과 port를 문서화하고 network policy나 firewall 규칙으로 최소 범위를 잡습니다. 이름 해석을 위해 DNS가 필요하다는 사실, 인증서 갱신에 외부 endpoint가 필요하다는 사실까지 목록에 넣지 않으면 배포 뒤 급하게 전체 egress를 여는 일이 생깁니다. 반대로 정책을 추가할 때는 timeout이 아니라 명시적인 deny 로그로 원인을 확인할 수 있게 해야 합니다.

host API도 같은 기준으로 봅니다. Kubernetes API token, cloud metadata endpoint, CI runner의 credential, container runtime socket은 단순한 환경 설정이 아니라 높은 권한의 원격 인터페이스입니다. service account token은 필요할 때만 mount하고, 권한은 namespace와 resource·verb 단위로 좁힙니다. workload가 자기 상태를 읽어야 한다고 해서 cluster 전체 secret을 읽을 필요는 없습니다. process capability를 줄이는 만큼, process가 호출할 수 있는 네트워크 API도 줄여야 실행 경계가 완성됩니다.

## Kubernetes의 선언과 runtime 동작을 함께 확인하기

Kubernetes manifest의 `securityContext`는 의도를 표현하는 출발점입니다. `runAsNonRoot`, `allowPrivilegeEscalation: false`, capability drop, `readOnlyRootFilesystem`, seccomp profile은 review 때 눈에 보이는 기본 방어선입니다. 그러나 manifest에 값이 있다고 runtime에서 같은 효과가 나는지 확인해야 합니다. admission policy가 값을 덮어쓰는지, chart의 다른 container가 예외인지, debug container와 init container에도 같은 기준이 적용되는지 놓치기 쉽습니다.

Pod Security Standards는 privileged·baseline·restricted처럼 위험한 설정을 분류하는 공통 기준을 제공합니다. 이는 모든 업무 요구를 판정하는 완성된 정책이라기보다, 최소한 어떤 manifest가 위험한지 일관되게 대화하기 위한 기준입니다. 조직은 이 기준 위에 image registry, 허용 volume type, host namespace 사용 여부, service account 예외 같은 자체 규칙을 더할 수 있습니다. 중요한 것은 정책이 통과했는지 하나의 boolean만 보지 않고, 어떤 예외가 왜 허용됐는지 reviewer와 운영자가 추적하는 것입니다.

예를 들어 log collector나 node-level monitoring agent는 host path·device·추가 capability가 필요할 수 있습니다. 이 workload를 일반 웹 API와 같은 namespace policy에서 억지로 통과시키면 둘 중 하나가 과도한 예외를 얻습니다. 시스템 수준 agent는 별도 namespace·service account·network 범위·검토 주기를 두고, 일반 application은 더 제한적인 기본 policy를 적용하는 편이 낫습니다. 권한 격리는 한 가지 설정값이 아니라 workload의 책임에 맞는 서로 다른 실행 계약입니다.

## 다중 컨테이너와 공유 volume의 경계

하나의 Pod 안에 application, proxy, log agent, migration helper가 함께 있으면 각 container의 `runAsUser`가 달라도 공유 volume이 실제 경계를 약하게 만들 수 있습니다. 특히 `emptyDir`에 token·socket·업로드 파일을 함께 두면 다른 container가 해당 파일을 읽거나 바꿀 수 있습니다. sidecar가 편리하다는 이유만으로 application secret과 proxy 인증서를 같은 directory에 두면, 한 container의 취약점이 다른 container의 권한으로 이어질 수 있습니다.

공유가 필요한 데이터는 목적별 volume과 mount path를 분리하고, 각 container에는 필요한 경로만 mount합니다. application이 proxy에 Unix socket으로 요청해야 한다면 socket의 owner·group·mode와 생성 시점을 정의하고, application image가 socket directory 전체를 수정하지 못하도록 합니다. init container는 초기화 작업이 끝난 뒤 사라진다는 이유로 무시하기 쉽지만, 실행 중에는 secret을 복사하거나 schema를 바꾸는 높은 권한을 가질 수 있으므로 별도 review 대상입니다.

이 구조는 장애 대응에도 영향을 줍니다. application 권한 오류를 고치려고 shared volume을 777로 바꾸면 당장은 배포가 통과해도 누가 쓰기 권한을 가져야 하는지 알 수 없게 됩니다. user ID·group ID·`fsGroup`·파일 생성 umask를 함께 설계하고, permission 변경이 어떤 container에 필요한지 테스트합니다. 좁은 공유 경계는 보안뿐 아니라 어떤 component가 파일을 망가뜨렸는지 찾는 운영 비용도 줄입니다.

## 변경과 장애를 위한 실행 경계 시뮬레이션

권한 hardening은 정상 배포가 된다는 것만으로 끝나지 않습니다. certificate가 만료됐을 때, disk가 가득 찼을 때, DNS가 실패했을 때, migration이 중단됐을 때처럼 운영자가 자주 만나는 상황에서 어떤 process가 무엇을 할 수 있는지 점검해야 합니다. 정상 동작을 위해 급히 privilege를 추가하는 대신, 장애 시나리오별로 필요한 읽기·쓰기·연결 권한을 정의하면 예외가 누적되는 일을 막을 수 있습니다.

예를 들어 worker가 처리 실패 파일을 quarantine volume으로 옮겨야 한다면, 원본 queue·quarantine·운영자 조회 경로를 분리해 봅니다. worker는 파일을 옮길 수 있지만 삭제하지 못하게 할지, 운영자는 별도 도구로 승인 후 삭제할지, 재처리 service는 어떤 identity로 실행할지를 결정합니다. 이 결정을 application 코드와 runbook에 같이 남겨야 권한 오류가 incident에서 "일단 root로 바꾸자"로 끝나지 않습니다.

변경 전에는 최소 두 가지 rollback을 준비합니다. 첫째, 새 security context가 기능 장애를 만들었을 때 직전의 검증된 manifest로 돌아가는 deployment rollback입니다. 둘째, 너무 넓은 예외를 긴급하게 넣었다면 만료 시점과 제거 조건을 가진 policy rollback입니다. 긴급 예외는 ticket·소유자·최대 기간·재현 조건을 남기고, 다음 release에서 더 작은 해결책으로 치환합니다. 이 흐름이 있어야 강한 기본값과 서비스 안정성을 함께 지킬 수 있습니다.

## 권한 오류를 재현하고 좁혀 가는 조사 절차

hardening을 적용한 뒤 가장 흔한 대응은 permission denied 한 줄을 보고 capability를 추가하거나 privileged 옵션을 켜는 것입니다. 이 방법은 배포를 빠르게 통과시키지만, 실제 실패 원인이 파일 ownership인지, LSM 정책인지, read-only filesystem인지, syscall 거절인지 구분하지 못하게 합니다. 조사 순서는 먼저 실패한 process의 user와 group, 실행 명령, 대상 resource, 시각을 확인하는 데서 시작합니다. 같은 image를 staging에서 같은 security context로 실행해 오류가 재현되는지도 확인합니다.

파일 접근 문제라면 `ls -ln`으로 이름이 아닌 UID와 GID를 보고, volume mount 옵션·init container가 만든 파일·application umask를 함께 봅니다. image 안에서는 10001 사용자로 실행하지만 persistent volume의 소유자가 1000이면, application은 root가 아니어서 쓰지 못하는 것이 정상입니다. 이때 해결책은 volume 준비 단계에서 필요한 소유권을 맞추거나 application의 writable directory를 분리하는 것입니다. 전체 filesystem을 writable로 바꾸거나 `chmod 777`로 푸는 것은 어느 process가 쓰는지 알 수 없게 만드는 임시 우회입니다.

syscall 또는 capability 문제는 실행 로그만으로 단정하지 않습니다. seccomp audit 이벤트, runtime의 deny message, application stack trace를 연결해 어떤 operation이 실패했는지 확인합니다. 예를 들어 low port bind가 실패했다면 `NET_BIND_SERVICE`가 필요한지, reverse proxy 뒤 high port를 쓸 수 있는지 비교합니다. raw socket 생성이 실패했다면 진짜 packet capture가 필요한지, application이 오래된 library 때문에 불필요한 호출을 하는지 먼저 판단합니다. 필요한 작업을 다른 architecture로 옮길 수 있다면 추가 capability보다 그 편이 안전합니다.

조사 결과로 예외를 추가해야 할 때도 최소 단위로 실험합니다. capability 하나, mount path 하나, policy rule 하나만 바꾸고 정상 동작과 거절돼야 하는 동작을 다시 실행합니다. 변경 전후 `id`, process capability, mount 목록, network connection을 수집해 runbook에 남기면 다음 장애에서 같은 넓은 권한을 되풀이하지 않아도 됩니다. 권한 설정은 장애를 없애는 버튼이 아니라 application의 실제 의존성을 측정하는 인터페이스로 다뤄야 합니다.

## 개발·CI·운영 환경의 차이를 관리하기

로컬 개발에서는 편의를 위해 source directory 전체를 bind mount하고, debugger·package manager·container runtime socket을 쓸 수 있게 두는 경우가 많습니다. 이 구성을 production manifest에 복사하면 개발 환경의 편의가 실행 권한으로 유입됩니다. 반대로 production에만 강한 정책을 적용하고 CI에서 검증하지 않으면, release 때마다 권한 오류가 처음 발견됩니다. 환경마다 위험 수준이 달라도, image가 non-root로 시작하고 임시 경로가 명확하며 불필요한 capability가 없다는 기본 계약은 가능한 한 공통으로 유지해야 합니다.

CI에서는 application 테스트 외에 manifest의 위험한 값을 빠르게 걸러낼 수 있습니다. privileged mode, host network·PID namespace, hostPath volume, allowPrivilegeEscalation, `CAP_SYS_ADMIN`, latest tag 같은 항목을 policy-as-code나 lint 규칙으로 확인합니다. 이 검사는 보안 팀만을 위한 gate가 아닙니다. reviewer가 chart template 깊숙이 들어가지 않아도 위험한 예외를 발견하게 해 주고, 예외가 의도된 것이라면 PR에 이유와 범위를 남기게 합니다.

staging은 production과 완전히 같은 data를 가져야 한다는 뜻이 아니라, security context와 network 경계가 기능을 막는지 확인할 수 있어야 한다는 뜻입니다. smoke test에는 service 시작, health check, 주요 읽기·쓰기, 외부 의존성 연결, graceful shutdown을 넣습니다. background job·cron·migration처럼 request path 밖에서 동작하는 process도 빠뜨리지 않습니다. 모든 환경을 동일하게 만들 수 없다면, 차이를 문서화하고 production에서만 필요한 host 접근은 별도 검토 대상으로 표시합니다.

## 소유권과 예외를 계속 줄이는 운영 습관

권한 정책이 시간이 지날수록 복잡해지는 이유는 서비스가 늘어서만이 아닙니다. 긴급 장애 때 만든 exception이 만료되지 않고, 담당자가 바뀌며, image와 runtime이 업데이트돼 원래 필요했던 권한이 남기 때문입니다. 따라서 예외에는 생성자뿐 아니라 현재 소유자, 적용 대상, 근거, 재검토 날짜가 필요합니다. 목록이 없다면 privileged workload 수나 추가 capability 수조차 정확히 알 수 없습니다.

월간 또는 분기 점검에서는 권한을 한 번에 강화하기보다, 예외 하나가 여전히 필요한지를 확인합니다. 최근 실행 로그에서 그 capability를 요구한 operation이 있었는지, product 변경으로 helper가 사라졌는지, runtime 기본 profile이 더 나은 보호를 제공하는지 살핍니다. 제거 후보는 staging에서 먼저 끄고 관찰합니다. 사용하지 않는 권한을 삭제하는 작은 변경이, 대규모 보안 재설계보다 지속 가능한 경우가 많습니다.

이 과정은 개발자에게 보안 업무를 떠넘기는 방식이 아니라, 서비스 ownership을 명확히 하는 방식입니다. platform 팀은 안전한 기본 template·정책·관찰 경로를 제공하고, application 팀은 필요한 예외의 업무 이유와 테스트를 제공하며, 보안 팀은 위험한 조합과 review 기준을 제시합니다. 세 역할이 하나의 "권한 요청" 티켓만 주고받으면 context가 사라지지만, manifest·테스트·runbook을 같은 변경에 묶으면 다음 배포에서도 설명 가능한 경계를 유지할 수 있습니다.

## 한계와 적용 기준 Q&A

### Q. capability를 전부 제거하면 컨테이너 탈출을 막을 수 있나요?

A. 위험을 줄이지만 완전한 보장은 아닙니다. kernel 취약점, host mount, privileged container, 잘못된 network 정책, application 비밀 정보 노출 같은 다른 경계가 남습니다. capability·seccomp·non-root·image 관리·patch·network policy를 함께 적용해야 합니다.

### Q. seccomp custom profile은 모든 서비스에 필요한가요?

A. 일반 workload는 runtime의 검증된 기본 profile로 시작하는 편이 현실적입니다. custom profile은 공격 표면이 매우 중요하거나 실행 요구가 잘 알려진 서비스에서 가치가 있을 수 있습니다. 유지할 관찰·테스트 역량이 없다면 너무 좁은 profile은 가용성 위험이 될 수 있습니다.

### Q. 권한 오류가 나면 어떻게 안전하게 해결하나요?

A. 먼저 어떤 사용자·파일·syscall·capability에서 실패했는지 확인합니다. 다음으로 더 좁은 writable path, 별도 helper, application 설정 변경으로 해결할 수 있는지 검토합니다. 전체 root 실행이나 privileged mode는 마지막 수단이며, 필요한 경우에도 범위와 기간을 명시해야 합니다.

## 도입 체크리스트

새 workload는 image USER, writable path, 필요한 port, volume, capability, seccomp profile, host 접근 여부를 배포 전에 목록화합니다. 기본 non-root·capability drop·no privilege escalation을 적용한 staging에서 정상·오류·reload·rollback을 검증하고, production에서는 permission 오류와 상태 변화를 관찰합니다. 예외는 이유와 소유자·재검토 시점을 남깁니다.

Linux 권한 격리는 설정 한 줄로 끝나는 보안 기능이 아닙니다. 서비스가 정말 필요한 권한을 이해하고 root·filesystem·capability·syscall·host 접근을 각각 줄이는 반복 작업입니다. 작은 기본값에서 시작해 실제 동작으로 검증하면, 장애를 피하려고 모든 경계를 푸는 대신 설명 가능한 안전한 실행 환경을 만들 수 있습니다.

권한을 설계하는 과정은 서비스의 의존성을 드러내는 과정이기도 합니다. 어떤 process가 어떤 경로에 쓰고, 어떤 socket에 연결하며, 어떤 helper를 실행하는지 목록화하면 불필요한 mount와 도구를 발견할 수 있습니다. 보안 검토를 release 직전의 승인 절차로만 두지 말고 image 설계·코드 리뷰·운영 runbook에 반복적으로 넣어야 합니다.

<h3 class="references-heading">참고 자료</h3>

- [Linux Kernel: Seccomp BPF](https://docs.kernel.org/userspace-api/seccomp_filter.html)
- [Linux capabilities(7)](https://man7.org/linux/man-pages/man7/capabilities.7.html)
