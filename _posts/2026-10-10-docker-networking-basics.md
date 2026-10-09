---
layout: post
title: "Docker 네트워킹을 이해하는 법: Bridge·DNS·포트 공개·NAT·Host·Overlay의 운영 경계"
date: 2026-10-10 08:30:01 +0900
categories: [infrastructure]
tags: [infrastructure, docker, networking, bridge, nat, dns, containers]
description: "Docker 네트워킹을 처음 접하는 사람을 위해 컨테이너 네임스페이스, bridge·host·overlay 네트워크, 포트 공개·NAT·내장 DNS와 보안·장애 분석 기준을 설명합니다."
---

Docker 컨테이너를 처음 실행하면 애플리케이션이 격리된 상자 안에서 돌아가는 것처럼 보입니다. 그런데 곧 질문이 생깁니다. 컨테이너끼리는 왜 이름으로 통신할 수 있을까? `-p 8080:80`은 정확히 무엇을 여는 걸까? 데이터베이스 컨테이너는 외부에 포트를 공개하지 않았는데 웹 컨테이너는 어떻게 접속할까? 호스트에서 `localhost`는 왜 컨테이너 안의 `localhost`와 다를까? 이 질문에 답하려면 Docker 명령 옵션보다 Linux 네트워크 네임스페이스, 가상 인터페이스, bridge, DNS, NAT(Network Address Translation, 네트워크 주소 변환)의 역할을 먼저 구분해야 합니다.

Docker의 네트워크 드라이버는 컨테이너를 어떤 네트워크 경계에 붙일지 결정합니다. 단일 호스트에서 가장 자주 쓰는 **bridge network**는 같은 사용자 정의 네트워크에 연결된 컨테이너가 서로 통신하고, 호스트·외부와의 노출은 포트 공개로 제어하도록 돕습니다. **host network**는 컨테이너가 호스트의 네트워크 스택을 더 직접 공유하게 하며, **overlay network**는 여러 Docker 호스트에 걸쳐 컨테이너·서비스를 연결하는 데 쓰입니다. 이름이 다르다고 보안 수준이 자동으로 정해지는 것은 아닙니다. 어떤 포트가 어느 주소에 바인딩됐고, 어떤 컨테이너가 같은 네트워크에 연결됐으며, 호스트 방화벽·클라우드 보안 그룹이 무엇을 허용하는지가 실제 노출을 결정합니다.

이 글은 Docker 네트워킹을 이해하기 위한 기반과 운영 기준을 다룹니다. 컨테이너 네트워크를 전부 직접 만들 필요는 없지만, 기본 동작을 모른 채 포트를 열거나 host network를 쓰면 내부 서비스가 의도치 않게 노출되거나 장애 원인을 찾기 어려워질 수 있습니다.

<section class="quick-answers">
  <p class="quick-label">먼저 답하면</p>
  <div class="quick-answer"><h3>Q. 같은 Docker Compose 프로젝트의 서비스는 포트를 공개해야 서로 통신하나요?</h3><p>A. 보통 필요하지 않습니다. 같은 사용자 정의 bridge network에 연결된 서비스는 Docker의 내부 DNS로 서비스 이름을 해석해 컨테이너 포트로 통신할 수 있습니다. 외부 사용자나 호스트에서 접근해야 할 포트만 publish하는 편이 노출을 줄입니다.</p></div>
  <div class="quick-answer"><h3>Q. `-p 8080:80`은 컨테이너의 80 포트만 여는 옵션인가요?</h3><p>A. 호스트의 8080 포트로 들어온 트래픽을 컨테이너의 80 포트로 전달하도록 publish하는 설정입니다. 호스트 IP를 생략하면 기본 바인딩 범위가 넓어질 수 있으므로, 인터넷 노출이 아닌 로컬 개발용이면 `127.0.0.1:8080:80`처럼 주소를 명시하는 편이 안전합니다.</p></div>
  <div class="quick-answer"><h3>Q. 컨테이너를 다른 bridge network에 나누면 완전히 안전하게 격리되나요?</h3><p>A. 네트워크 분리는 중요한 경계지만 전부가 아닙니다. 같은 호스트의 Docker 권한, published port, host firewall, 애플리케이션 인증·인가, 볼륨 공유, 관리 API 권한도 함께 고려해야 합니다. 분리는 접근 가능한 경로를 줄이는 장치입니다.</p></div>
</section>

## 먼저 알아둘 기반 기술: 네임스페이스·인터페이스·IP·포트·DNS·NAT

Linux의 **네트워크 네임스페이스(network namespace)** 는 프로세스 그룹마다 네트워크 장치, IP 주소, 라우팅 테이블, 포트 공간을 분리하는 커널 기능입니다. Docker 컨테이너는 보통 자신만의 네트워크 네임스페이스를 갖습니다. 그래서 서로 다른 컨테이너가 각각 `127.0.0.1:8080`을 사용할 수 있고, 컨테이너 안의 `localhost`는 기본적으로 그 컨테이너 자신을 가리킵니다. 호스트의 `localhost`나 다른 컨테이너의 `localhost`를 뜻하지 않습니다.

컨테이너 네임스페이스와 호스트 네트워크를 연결할 때는 흔히 **veth pair**라는 가상 인터페이스 쌍을 사용합니다. 한쪽 끝은 컨테이너에 `eth0`처럼 보이고, 다른 쪽은 호스트의 가상 bridge에 붙습니다. **bridge**는 여러 인터페이스를 같은 L2 네트워크처럼 연결하는 소프트웨어 스위치 역할을 합니다. 같은 bridge에 붙은 컨테이너는 서로의 IP로 통신할 수 있고, Docker는 사용자 정의 bridge에서 컨테이너 이름을 찾는 DNS 기능도 제공합니다.

**IP 주소**는 어느 네트워크·호스트로 보낼지를, **포트**는 그 호스트 안에서 어느 프로세스가 받을지를 구분합니다. 컨테이너에 172.x.x.x 같은 내부 IP가 있어도 외부 네트워크 장비는 그 주소로 직접 라우팅하지 못하는 경우가 많습니다. 이때 Docker는 호스트 IP와 published port를 통해 들어온 요청을 컨테이너 IP·포트로 전달하는 NAT·포트 포워딩 규칙을 설정할 수 있습니다.

**DNS(Domain Name System)** 는 이름을 IP로 바꾸는 시스템입니다. 사용자 정의 Docker bridge에서 `api`라는 서비스가 있다면 같은 네트워크의 `web` 컨테이너는 `http://api:8080`처럼 이름으로 접근할 수 있습니다. 컨테이너 IP는 재생성 때 바뀔 수 있으므로, 코드나 설정에 컨테이너 IP를 고정하기보다 서비스 이름을 쓰는 편이 좋습니다. 단, DNS 이름이 해결된다고 연결이 성공한다는 뜻은 아닙니다. 대상 프로세스가 리슨하는지, 같은 네트워크에 있는지, 포트·TLS·애플리케이션 설정이 맞는지도 확인해야 합니다.

## 기본 bridge와 사용자 정의 bridge: 비슷해 보여도 운영성이 다르다

Docker daemon이 시작되면 기본 `bridge` 네트워크가 만들어지고, 네트워크를 지정하지 않은 컨테이너는 여기에 연결될 수 있습니다. 하지만 서비스 단위 구성에는 보통 **사용자 정의 bridge network**가 더 적합합니다. Docker 공식 문서에 따르면 사용자 정의 bridge는 컨테이너 이름 기반의 자동 DNS 해석을 제공하며, 기본 bridge에서의 legacy `--link`에 의존하지 않아도 됩니다. 또한 애플리케이션·DB·캐시를 같은 프로젝트 네트워크로 묶고 다른 프로젝트와 분리하는 의도를 표현하기 좋습니다.

다음은 웹과 DB를 같은 내부 네트워크에 두고, 웹만 로컬 호스트에 공개하는 예입니다.

```yaml
services:
  web:
    image: example/web:latest
    ports:
      - "127.0.0.1:8080:8080"
    networks: [app-net]

  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: change-me-in-a-secret-store
    networks: [app-net]

networks:
  app-net:
    driver: bridge
```

이 예시에서 `web`은 호스트의 loopback에만 8080을 바인딩하므로, 같은 호스트의 프록시나 개발자가 `localhost:8080`으로 접근할 수 있습니다. 외부 네트워크에서 직접 접근해야 한다면 프록시·방화벽·TLS·인증 경계까지 설계해야 하며, 단순히 `0.0.0.0`에 포트를 열기 전에 이유를 확인해야 합니다. `db`는 ports를 선언하지 않았지만 같은 `app-net`의 `web`에서 `db:5432`로 연결할 수 있습니다. DB 포트를 외부에 publish하지 않는 것이 DBMS 계정·TLS·네트워크 ACL을 대체하지는 않지만 불필요한 노출 경로를 줄입니다.

Compose가 자동으로 네트워크를 만드는 경우에도 실제 네트워크 이름, 연결된 컨테이너, IPAM 설정, published port를 `docker network inspect`와 `docker ps`로 확인할 수 있습니다. “Compose가 알아서 해 준다”는 것은 정책이 필요 없다는 뜻이 아닙니다. 새 서비스가 어느 network에 붙는지, 운영 환경과 개발 환경의 차이가 무엇인지, 외부 의존성은 어느 DNS 이름으로 접근하는지 구성 코드에서 명시해야 합니다.

## 포트 공개와 EXPOSE: 문서화와 실제 노출을 구분한다

Dockerfile의 `EXPOSE 8080`은 이미지가 어떤 포트를 사용한다고 알리는 메타데이터·문서화에 가깝습니다. 그 자체로 호스트나 인터넷에 포트를 열지는 않습니다. 반면 `docker run -p 8080:8080` 또는 Compose의 `ports`는 호스트 포트와 컨테이너 포트를 연결하는 실제 publish 설정입니다. 두 개념을 혼동하면 이미지에 EXPOSE가 있으니 외부에서 열려 있을 것이라 오해하거나, ports를 추가했는데 생각보다 넓은 범위에 노출되는 실수를 할 수 있습니다.

포트 publish에서 앞쪽은 호스트의 주소·포트, 뒤쪽은 컨테이너의 포트입니다.

```bash
# 모든 호스트 IPv4/IPv6 주소에 8080을 publish할 수 있는 형태
docker run -p 8080:80 example/web

# 이 호스트의 loopback에서만 publish
docker run -p 127.0.0.1:8080:80 example/web

# 특정 사설 인터페이스 주소에만 publish
docker run -p 10.10.20.15:8443:443 example/web
```

실제 기본 바인딩 동작은 Docker 설정과 IPv4·IPv6 구성에 따라 확인해야 합니다. Docker 문서도 호스트 주소를 생략한 포트 publish의 기본 바인딩 범위와, 특정 IP를 명시해 노출을 제한하는 방법을 설명합니다. 특히 클라우드 VM에서 `-p 8080:80`을 개발용으로 실행했다가 공인 인터페이스에 열리는 상황을 피하려면, `ss -lntp`, `docker ps`, 클라우드 보안 그룹, host firewall을 함께 확인해야 합니다.

컨테이너가 `0.0.0.0:80`에 리슨하는 것과 호스트 포트를 publish하는 것도 다른 층입니다. 컨테이너 안에서 `127.0.0.1:80`에만 리슨하면 Docker가 패킷을 전달해도 컨테이너의 외부 인터페이스에서 받지 못할 수 있습니다. 반대로 컨테이너가 모든 인터페이스에 리슨해도 ports를 publish하지 않았다면 호스트 밖에서 바로 접근할 수 없을 수 있습니다. 네트워크 장애를 볼 때는 애플리케이션 리슨 주소, Docker publish, host firewall, 외부 네트워크 경계를 순서대로 분리해야 합니다.

## container-to-container 통신: 이름, 포트, 네트워크가 모두 맞아야 한다

같은 사용자 정의 bridge network에 붙은 컨테이너는 service/container 이름을 DNS로 해석할 수 있습니다. 이것은 개발 환경에서 IP를 하드코딩하지 않게 해 주지만, `localhost`를 서비스 이름처럼 쓸 수 있다는 뜻은 아닙니다. web 컨테이너에서 DB로 접속할 때 `localhost:5432`는 web 컨테이너 자신에게 연결을 시도합니다. 보통은 `db:5432`처럼 DB 서비스 이름을 사용해야 합니다.

또한 ports에 호스트 publish를 선언했다고 해서 다른 컨테이너가 그 호스트 포트를 경유해야 하는 것은 아닙니다. 같은 network라면 대상 컨테이너의 내부 포트로 직접 연결하는 편이 더 단순하고, 불필요한 host NAT·외부 노출을 피할 수 있습니다. 예를 들어 `web → db:5432`는 내부 경로이고, `사용자 브라우저 → host:8080 → web:8080`은 외부 진입 경로입니다. 두 경로를 구성과 문서에서 구분하면 “DB가 외부에 공개됐는가?” 같은 질문에 명확히 답할 수 있습니다.

한 컨테이너가 여러 network에 연결될 수도 있습니다. 예를 들어 reverse proxy는 `public-net`과 `app-net` 둘에 연결해 외부 요청을 웹 서비스로 전달하고, DB는 `app-net`에만 연결합니다. 이 구조는 모든 서비스를 한 평면에 두는 것보다 경계를 표현하기 좋습니다. 그러나 proxy가 두 네트워크를 연결한다고 자동으로 모든 정책을 검사하는 것은 아닙니다. proxy 설정, 인증, 헤더, TLS, 애플리케이션 권한, host 방화벽을 별도로 관리해야 합니다.

## bridge·host·none·overlay: 드라이버를 역할로 선택한다

**bridge**는 단일 Docker 호스트에서 일반 서비스 간 통신을 만들기 좋은 기본 선택입니다. 사용자 정의 bridge는 이름 기반 DNS, 프로젝트 단위 분리, 포트 publish와의 조합이 이해하기 쉽습니다. 대부분의 단일 서버 Compose 애플리케이션은 이 모델에서 시작할 수 있습니다.

**host network**는 컨테이너가 호스트의 네트워크 네임스페이스를 공유하도록 합니다. 이 경우 컨테이너는 별도 IP·포트 공간을 갖지 않으므로 NAT·포트 매핑 오버헤드가 줄거나 네트워크 도구가 호스트 인터페이스를 직접 봐야 하는 상황에 쓰일 수 있습니다. 하지만 포트 충돌 가능성이 커지고 격리 수준이 낮아지며, `-p`가 기대처럼 의미 없거나 무시될 수 있습니다. ‘네트워크가 안 되니 host 모드로 바꾸자’는 해결책은 원인을 감추고 보안 경계를 약화시킬 수 있으므로, 필요한 이유가 명확할 때만 사용해야 합니다.

**none network**는 컨테이너에 loopback 외의 네트워크를 연결하지 않는 방식입니다. 네트워크가 필요 없는 배치·파일 변환 같은 작업에서 공격 표면을 줄일 수 있지만, DNS·패키지 다운로드·원격 API가 필요한 프로세스에는 맞지 않습니다. 빌드나 테스트에 none을 적용할 때도 필요한 의존성을 미리 준비했는지 확인해야 합니다.

**overlay network**는 여러 Docker daemon 호스트에 걸쳐 네트워크를 만들 때 사용합니다. Docker 문서에 따르면 overlay는 Swarm에 참여한 호스트 사이의 분산 네트워크를 만들며, 참여 호스트 사이에 control plane·데이터 경로에 필요한 포트를 열어야 합니다. 단일 VM의 Compose 서비스에 overlay를 도입하면 해결할 문제가 늘어날 수 있습니다. 여러 노드의 서비스 발견과 연결이 실제 요구일 때에만 선택하고, 클러스터 네트워크·암호화·MTU·방화벽·장애 조치까지 함께 검증해야 합니다.

## Docker가 만든 방화벽 규칙과 직접 만든 규칙이 만날 때

Docker는 bridge networking과 published port를 위해 호스트의 패킷 필터·NAT 규칙을 설정합니다. 이는 컨테이너가 외부와 통신하고 host port로 들어온 요청이 올바른 컨테이너에 전달되도록 돕습니다. 따라서 nftables나 iptables를 직접 관리하는 서버에서 `flush ruleset`처럼 전체 규칙을 비우는 작업은 Docker 네트워크까지 끊을 수 있습니다. 반대로 host firewall에서 forward 경로를 차단하면 컨테이너 publish가 예상대로 동작하지 않을 수 있습니다.

어제 다룬 nftables처럼, 여기서도 중요한 것은 규칙의 **소유자**입니다. Docker daemon, firewalld/ufw, 클라우드 에이전트, 사용자가 작성한 nftables 구성, Kubernetes/CNI가 같은 호스트에서 각각 네트워크 규칙을 관리할 수 있습니다. 컨테이너 통신이 안 된다고 Docker가 만든 체인을 임의로 삭제하거나, 보안을 강화한다고 전체 forward policy를 바꾸면 다른 서비스의 경로를 깨뜨릴 수 있습니다. 먼저 `docker network inspect`, `docker ps`, `nft list ruleset` 또는 `iptables -S`, host route를 관찰해 패킷이 어느 경로를 지나는지 확인합니다.

Docker와 host firewall을 함께 쓸 때는 컨테이너의 published port를 어느 인터페이스에서 받을지, 컨테이너 간 내부 통신을 어디까지 허용할지, host 자체로 들어오는 관리 포트와 컨테이너로 forward되는 포트를 어떻게 구분할지 문서화합니다. Docker가 기본 규칙을 만든다고 해서 조직의 네트워크 정책이 자동 적용되는 것은 아닙니다. 반대로 host firewall이 있다고 해서 Compose 파일의 `ports`를 아무 생각 없이 늘려도 되는 것도 아닙니다.

## 가상의 업무 예시: 웹·API·DB를 한 서버에서 분리하기

가상의 소규모 서비스가 한 Linux VM에서 reverse proxy, web UI, API, PostgreSQL을 컨테이너로 실행한다고 해 보겠습니다. 외부 인터넷에서 받아야 하는 것은 proxy의 HTTPS뿐입니다. web UI와 API는 `app-net`에 연결하고, DB는 `data-net`에 연결합니다. proxy는 외부와 app-net 둘에 연결해 TLS 종료 뒤 web/API로 요청을 전달합니다. API는 app-net과 data-net 둘에 연결하고, DB는 data-net에만 둡니다.

이때 DB에 ports를 선언하지 않으면 host 외부에서 DB 포트로 직접 연결할 길이 줄어듭니다. API는 `db:5432`라는 내부 DNS 이름으로 연결하고, proxy는 `api:8080`과 `web:3000`처럼 app-net 안의 이름을 사용합니다. 외부 노출은 proxy의 `443` publish 하나로 좁힐 수 있습니다. 물론 DB의 비밀번호·TLS·역할 권한, API 인증·인가, proxy 취약점·host 접근 권한은 여전히 필요합니다. 네트워크 분리는 여러 방어층 중 하나입니다.

장애가 나면 경로를 단계별로 봅니다. 브라우저에서 proxy의 443에 연결되는가? proxy 컨테이너가 app-net의 API 이름을 해석하고 포트에 연결되는가? API가 data-net의 DB 이름을 해석하고 인증되는가? 각 컨테이너가 실제로 어느 IP에 리슨하는가? host에서 443이 어느 주소에 publish됐는가? 이 질문을 한 번에 `curl` 하나로 답하려 하면 원인을 섞게 됩니다. 컨테이너 안에서의 DNS·TCP 확인, host의 publish·방화벽 확인, 애플리케이션 로그를 분리하면 문제 범위가 줄어듭니다.

## 진단 순서: 이름 해석부터 포트 바인딩까지 계층을 나눈다

컨테이너 통신이 실패할 때는 다음 순서가 유용합니다. 먼저 `docker ps`와 `docker network inspect`로 컨테이너가 기대한 network에 연결돼 있는지 봅니다. 다음으로 실행 중인 컨테이너 안에서 대상 서비스 이름이 해석되는지, 대상 포트에 TCP 연결이 되는지 확인합니다. 그 다음 대상 컨테이너가 올바른 인터페이스·포트에 리슨하는지와 애플리케이션 로그를 봅니다. 외부에서만 실패한다면 host의 publish 상태, `ss -lntp`, firewall, 클라우드 보안 그룹, DNS와 TLS를 점검합니다.

```bash
docker network ls
docker network inspect app-net
docker ps --format "table {{.Names}}\t{{.Ports}}\t{{.Networks}}"
docker exec web getent hosts db
docker exec web sh -c 'nc -vz db 5432'
docker exec db ss -lnt
ss -lntp
```

명령의 사용 가능 여부와 결과는 이미지에 포함된 도구에 따라 다릅니다. 운영 컨테이너에 진단 도구를 무분별하게 추가하기보다, 승인된 ephemeral debug container나 별도 관측 도구를 사용할 수 있는지 검토합니다. 비밀번호·토큰을 명령줄에 넣으면 shell history나 프로세스 목록에 남을 수 있으므로, 연결 검사에서도 비밀 처리 원칙을 지켜야 합니다.

## 운영 기준: 개발 편의용 설정을 운영에 그대로 옮기지 않는다

개발 환경에서는 빠른 확인을 위해 여러 ports를 `0.0.0.0`에 publish하거나, 모든 서비스를 같은 network에 두거나, `--network host`를 쓸 수 있습니다. 운영에서는 이런 편의가 의도치 않은 노출·포트 충돌·권한 확대로 이어질 수 있습니다. Compose 파일을 환경별로 분리하거나, 공개 포트·network 연결·secrets·health check를 배포 파이프라인에서 검토하는 이유입니다.

이미지 태그도 네트워크와 관계가 있습니다. 서비스 재배포 때 컨테이너 IP는 바뀔 수 있지만 네트워크 이름과 service name은 유지되는 구성을 만들면, 애플리케이션이 IP 변경에 덜 흔들립니다. 반면 외부 DNS, 로드밸런서 대상, 인증서, IP allowlist는 컨테이너 내부 DNS와 다른 생명주기를 가질 수 있습니다. 내부 서비스 발견과 외부 공개 주소를 같은 방식으로 다루지 말아야 합니다.

모니터링에는 연결 수·DNS 실패·TCP connect 오류·HTTP 오류·NAT/host firewall 로그·컨테이너 재시작을 함께 봅니다. `connection refused`는 대상 포트에 리슨하는 프로세스가 없거나 즉시 거부한 경우일 수 있고, `timeout`은 패킷 경로·firewall·네트워크 문제일 수 있지만 항상 그렇지는 않습니다. 오류 문자열 하나로 결론내리지 말고, 요청이 어느 네트워크 경계까지 갔는지의 증거를 모아야 합니다.

## IPAM과 주소 충돌: 개발 환경이 많아질수록 먼저 확인할 것

Docker는 network를 만들 때 보통 사설 IP 대역을 자동으로 할당합니다. 이 과정을 IPAM(IP Address Management, IP 주소 관리)이라고 생각할 수 있습니다. 자동 할당은 시작하기 편하지만, 회사 VPN·사내망·다른 Docker host·Kubernetes·클라우드 VPC와 대역이 겹치면 예상하지 못한 라우팅 문제가 생길 수 있습니다. 예를 들어 컨테이너 network가 회사 내부 API 대역과 같은 `172.x.x.x` 범위를 쓰면, 호스트가 어느 경로로 패킷을 보내야 할지 혼동할 수 있습니다.

이 문제는 개발자 개인 PC에서는 간헐적으로 보이다가 VPN 접속, 원격 DB 테스트, 특정 사내 서비스 연결 때만 드러나기 쉽습니다. 그래서 조직에서 Docker를 넓게 쓰거나 여러 Compose 프로젝트·원격 daemon을 운영한다면, 사용 가능한 container subnet 범위와 피해야 할 회사·클라우드 대역을 정해 두는 것이 좋습니다. 필요한 경우 Compose network에 subnet을 명시할 수 있지만, 각 팀이 임의로 대역을 고정하면 또 다른 충돌이 생길 수 있습니다. 주소 계획은 편의 설정이 아니라 공유 인프라의 자원 관리입니다.

```yaml
networks:
  app-net:
    driver: bridge
    ipam:
      config:
        - subnet: 172.28.10.0/24
```

이 예시는 문법을 보여 주는 것이며, 실제 대역은 기존 VPN·VPC·노드·다른 Compose 프로젝트의 주소 계획을 확인한 뒤 선택해야 합니다. 또한 컨테이너에 고정 IP를 주는 것은 장애 조사에는 편해 보여도 재배포·확장·서비스 발견을 어렵게 할 수 있습니다. 대부분의 애플리케이션은 IP 대신 service name으로 연결하고, 주소 고정은 정말 필요한 네트워크 장비 연동이나 특별한 테스트에만 제한하는 편이 낫습니다.

## IPv6와 MTU: IPv4에서 되던 통신이 항상 같지는 않다

Docker network가 IPv4만 쓰는 것처럼 보여도 호스트·클라우드·사용자 브라우저는 IPv6를 사용할 수 있습니다. published port가 어느 IP family에 바인딩되는지, 컨테이너 network에서 IPv6를 쓸지, 외부 DNS의 AAAA 레코드가 어떤 경로를 여는지 명확히 해야 합니다. IPv4에서는 방화벽·보안 그룹이 맞는데 IPv6에서는 규칙이 누락돼 서비스가 노출되거나, 반대로 IPv6 사용자만 접속에 실패하는 문제가 생길 수 있습니다.

**MTU(Maximum Transmission Unit, 한 패킷에 실을 수 있는 최대 크기)** 도 multi-host·VPN·overlay에서 자주 나타나는 문제입니다. 캡슐화가 추가되는 overlay나 VPN은 실제 데이터에 쓸 수 있는 크기를 줄일 수 있습니다. 호스트와 컨테이너가 서로 다른 MTU를 가정하면 작은 요청은 되는데 큰 응답·이미지 업로드·TLS handshake 일부가 시간 초과되는 식의 증상이 생길 수 있습니다. 이 경우 애플리케이션 재시도만 늘리기보다 네트워크 경로·캡슐화·ICMP 메시지·driver MTU 설정을 확인해야 합니다.

Docker bridge driver에는 MTU와 관련한 옵션이 있지만, 숫자를 무작정 낮추는 방식은 다른 성능·경로 문제를 만들 수 있습니다. 실제로 어떤 인터페이스·VPN·cloud path가 병목인지 확인하고, 스테이징에서 큰 패킷·대용량 전송·여러 노드 경로를 검증한 뒤 적용해야 합니다. 네트워킹 문제는 컨테이너 설정 한 줄이 아니라 호스트·스위치·VPN·클라우드의 여러 계층에서 생길 수 있습니다.

## DNS와 외부 의존성: 내부 서비스 이름과 공용 이름을 분리한다

Docker 내부 DNS는 같은 network 안에서 서비스 이름을 찾는 데 편리합니다. 하지만 `db`, `api`, `redis` 같은 이름은 외부 DNS에 존재하지 않으며, 다른 Docker project나 다른 호스트에서 동일하게 해석된다는 보장도 없습니다. 반대로 외부 도메인을 컨테이너가 조회할 때는 호스트의 resolver, VPN DNS, proxy, split-horizon DNS 정책이 영향을 줄 수 있습니다.

내부 service discovery와 외부 endpoint를 구분하는 설정이 필요합니다. 애플리케이션이 컨테이너 내부에서는 `http://api:8080`으로 통신하고, 브라우저에는 `https://app.example.com`을 제공하는 것은 자연스러운 구조입니다. 이 둘을 같은 환경 변수에 억지로 넣으면 브라우저가 `api`라는 내부 이름으로 리다이렉트되거나, 서버가 자신의 공용 URL을 잘못 생성하는 오류가 생길 수 있습니다. internal base URL과 public base URL을 분리하고, 어느 코드가 어느 값을 쓰는지 문서화하는 편이 좋습니다.

DNS 오류를 볼 때도 `getent hosts api`의 성공만으로 충분하지 않습니다. 이름이 여러 IP를 돌려주는지, IPv4·IPv6 중 어떤 주소를 선택하는지, DNS TTL과 컨테이너 재배포가 어떻게 만나는지, 외부 resolver가 사내 도메인을 볼 수 있는지 확인합니다. 서비스 이름이 resolve되지 않을 때 단순히 `/etc/hosts`에 IP를 추가하면 다음 재배포에서 다시 깨질 수 있습니다. 우선 같은 network 연결·service name·Compose project 범위가 맞는지 확인하는 것이 근본 원인에 가깝습니다.

## 보안과 권한: network 분리만으로 컨테이너를 신뢰하지 않는다

컨테이너가 서로 다른 bridge network에 있다는 것은 기본적인 통신 경계를 제공하지만, Docker daemon을 제어할 수 있는 사용자는 새 컨테이너를 붙이거나, 볼륨을 마운트하거나, 포트를 publish할 수 있을 수 있습니다. Docker socket 접근 권한은 매우 강력하므로 애플리케이션 계정이나 CI job에 무심코 부여하면 network 분리의 의미가 줄어듭니다. 누가 Compose를 배포하고 `docker exec`를 실행할 수 있는지, secrets를 읽을 수 있는지, 이미지 공급망을 변경할 수 있는지도 함께 관리해야 합니다.

또한 한 컨테이너가 compromise됐을 때 같은 network의 어떤 서비스로 연결할 수 있는지를 생각해야 합니다. DB와 cache, 내부 admin API를 모두 하나의 넓은 bridge에 놓으면 공격자가 lateral movement를 할 경로가 늘어납니다. 역할별 network를 나누고, 불필요한 service attachment를 제거하며, 애플리케이션 인증·TLS·DB 최소 권한을 적용하는 이유입니다. 더 강한 격리가 필요하면 host firewall, eBPF 기반 정책, Kubernetes NetworkPolicy, 별도 노드·VPC 분리 같은 계층을 검토합니다.

비밀값도 네트워크 설정과 함께 새기 쉽습니다. 앞선 Compose 예시의 비밀번호는 실제 운영에서 파일에 평문으로 넣지 말아야 하며, secrets manager·CI secret·권한 분리 같은 경로를 사용해야 합니다. 컨테이너를 실행한 명령의 환경 변수, inspect 출력, 로그에 비밀이 나타날 수 있다는 점도 기억해야 합니다. 네트워크 문제를 진단한다며 전체 Compose 설정을 외부 채널에 붙여 넣으면 host 주소·내부 도메인·인증 정보가 함께 노출될 수 있습니다.

## 배포와 롤백: network 변경도 호환성 변경이다

network 이름, alias, published port, subnet, driver를 바꾸는 일은 애플리케이션 관점에서는 API endpoint 변경과 비슷합니다. 새 API 컨테이너를 다른 network에만 붙였는데 proxy가 이전 network에 남아 있으면 배포 직후 502가 날 수 있습니다. DB port를 publish하지 않도록 바꿨는데 백업 agent가 host port를 사용하고 있었다면 백업이 실패할 수 있습니다. 구성 변경 전에 누가 그 경로를 쓰는지 확인하고, health check·합성 요청·백업·모니터링 경로를 배포 검증에 넣어야 합니다.

롤백도 이미지 태그만 되돌리는 것으로 충분하지 않을 수 있습니다. network를 삭제하거나 subnet을 바꾸면 기존 컨테이너·연결·DNS 레코드가 영향을 받을 수 있습니다. 변경 전 `docker network inspect`와 Compose 정의를 보존하고, 새 network를 만든 뒤 서비스 하나씩 연결을 옮기는 식의 점진 전환을 고려합니다. 대규모 운영 환경에서는 IaC나 구성 관리의 선언 원천을 바꾸고 코드 리뷰·staging 검증을 거쳐 배포해야 합니다.

컨테이너 네트워킹은 개발자의 로컬 편의와 운영의 가용성·보안이 만나는 지점입니다. 그래서 `docker network create`가 성공했는지보다, 사용자 경로·내부 경로·관리 경로가 모두 의도대로 작동하는지 확인해야 합니다. 명시적인 network 경계, 최소 publish, service name 기반 연결, 검증 가능한 롤백은 작은 Compose 프로젝트에서도 가치가 있습니다.

## 한계와 적용 기준 Q&A

### Q. 사용자 정의 bridge를 만들면 NetworkPolicy처럼 세밀한 통제가 되나요?

A. bridge 분리는 같은 네트워크에 연결된 컨테이너 사이의 기본 경계를 만들지만, Kubernetes NetworkPolicy 같은 선언적 L3/L4 정책 체계를 그대로 제공한다는 뜻은 아닙니다. 더 세밀한 통제가 필요하면 host firewall, 서비스 메시, Kubernetes NetworkPolicy, 클라우드 보안 정책처럼 환경에 맞는 계층을 검토해야 합니다. 먼저 어떤 통신을 차단하려는지 정의해야 합니다.

### Q. DB 포트를 publish하지 않으면 백업·관리 도구도 접속할 수 없나요?

A. 같은 Docker network의 백업 컨테이너는 DB 서비스 이름과 내부 포트로 접속할 수 있습니다. host에서 관리해야 한다면 loopback 또는 VPN·bastion 전용 인터페이스에 제한해 publish하는 방법을 검토할 수 있습니다. 외부에 광범위하게 DB 포트를 여는 것보다 관리 경로를 명시적으로 설계하고 DBMS 인증·TLS·감사를 함께 적용하는 편이 안전합니다.

### Q. host network가 더 빠르다면 항상 쓰는 것이 좋지 않나요?

A. 성능 이득이 실제 병목을 해결하는지 먼저 측정해야 합니다. host network는 포트 namespace와 네트워크 격리를 줄이고, 동일 호스트의 다른 서비스와 충돌할 수 있습니다. 일반 웹·API 서비스에서는 사용자 정의 bridge와 명시적 publish가 더 읽기 쉽고 안전한 기본값인 경우가 많습니다. 패킷 캡처·특수 프로토콜·성능 요구처럼 분명한 이유가 있을 때만 선택합니다.

### Q. 컨테이너 이름으로 연결되는데 외부 접속이 실패하는 이유는 무엇인가요?

A. 내부 DNS와 외부 노출은 다른 경로입니다. 서비스 이름 해석은 같은 Docker network 안에서만 유효할 수 있고, 외부 접속에는 host port publish, host/firewall, 클라우드 보안 그룹, 공인 DNS, TLS가 모두 맞아야 합니다. 컨테이너 내부 성공만으로 외부 사용자 경로가 성공했다고 판단하면 안 됩니다.

## 마무리

Docker 네트워킹은 컨테이너를 연결하는 편의 기능이면서 서비스 경계를 표현하는 기반입니다. bridge의 이름 기반 DNS, 내부 포트 통신, host port publish, NAT와 firewall의 역할을 구분하면 `localhost` 혼동과 불필요한 포트 노출을 줄일 수 있습니다. 단일 호스트에서는 사용자 정의 bridge와 필요한 포트만 명시적으로 publish하는 방식부터 시작하고, multi-host가 실제 요구일 때 overlay를 검토하는 편이 좋습니다. 네트워크 드라이버를 바꾸기 전에 패킷이 어느 네임스페이스·인터페이스·방화벽 경계를 지나는지 확인하는 습관이 안정적인 컨테이너 운영의 출발점입니다.

<h3 class="references-heading">참고 자료</h3>

- [Docker Docs, Networking overview](https://docs.docker.com/engine/network/)
- [Docker Docs, Bridge network driver](https://docs.docker.com/engine/network/drivers/bridge/)
- [Docker Docs, Host network driver](https://docs.docker.com/engine/network/drivers/host/)
- [Docker Docs, Overlay network driver](https://docs.docker.com/engine/network/drivers/overlay/)
- [Docker Docs, Packet filtering and firewalls](https://docs.docker.com/engine/network/packet-filtering-firewalls/)
