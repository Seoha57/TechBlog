---
layout: post
title: "HAProxy 입문: 로드밸런싱 알고리즘과 헬스체크로 서버 풀을 안전하게 운영하기"
categories: [Infrastructure]
tags: [infrastructure, haproxy, load-balancer, health-check, reverse-proxy, tls, high-availability]
description: "HAProxy(에이치에이프록시)가 무엇이고 왜 쓰는지, frontend·backend·ACL 구조, 분산 알고리즘 선택, 헬스체크와 서버 상태 전이, 세션 유지, 런타임 API를 이용한 무중단 배포와 장애 점검 절차를 처음 접하는 독자도 따라 할 수 있도록 설정 예시와 함께 설명합니다."
---

## 먼저 답하기

### Q. HAProxy는 무엇인가요?

A. HAProxy(High Availability Proxy, 고가용성 프록시)는 들어오는 네트워크 연결이나 HTTP 요청을 받아 여러 대의 뒤쪽 서버에 나누어 전달하는 오픈소스 로드밸런서(load balancer, 부하 분산 장치) 겸 프록시 소프트웨어입니다. 앞에서는 하나의 주소로 요청을 받고, 뒤에서는 서버 여러 대를 "서버 풀"로 묶어 관리합니다. 서버가 죽으면 풀에서 빼고, 살아나면 다시 넣는 일을 자동으로 합니다. 이 글은 공식 문서를 바탕으로 개념과 설정을 정리한 학습 자료이며, 제가 직접 운영하면서 성능을 측정한 결과가 아닙니다. 아래 설정 예시는 문서의 문법에 맞춰 작성한 것이므로, 실제 환경에 적용하기 전에 반드시 `haproxy -c`로 문법 검사를 하고 시험 환경에서 먼저 확인하세요.

### Q. 왜 서버 앞에 따로 로드밸런서를 두나요?

A. 서버 한 대로 서비스하면 그 서버가 죽거나 배포로 재시작되는 순간 서비스 전체가 멈춥니다. 서버를 여러 대로 늘려도 클라이언트가 각 서버 주소를 직접 알고 있으면 어느 서버가 살아 있는지 클라이언트가 판단해야 합니다. 로드밸런서는 "접속 창구를 하나로 통일하고, 창구 뒤에서 살아 있는 서버에만 일을 배분"해 주는 장치입니다. 서버 증설, 배포, 장애 격리를 클라이언트가 모르게 처리할 수 있다는 것이 핵심 이유입니다.

### Q. 분산과 헬스체크는 어떻게 다른가요?

A. 분산(balancing)은 "다음 요청을 어느 서버에 보낼까"를 정하는 규칙이고, 헬스체크(health check, 상태 점검)는 "그 서버가 지금 요청을 받아도 되는 상태인가"를 주기적으로 확인하는 장치입니다. 분산 알고리즘만 있고 헬스체크가 없으면 죽은 서버에도 요청을 계속 보내 오류가 납니다. 반대로 헬스체크만 있고 분산이 편향되면 살아 있는 서버 하나에 몰려 과부하가 생깁니다. 두 장치가 함께 있어야 합니다. 자세한 설정은 아래 「분산 알고리즘 선택」과 「헬스체크와 서버 상태 전이」 절에서 다룹니다.

### Q. 항상 HAProxy를 써야 하나요?

A. 아닙니다. 쿠버네티스 안에서는 Ingress나 Gateway API 구현체, 클라우드에서는 관리형 로드밸런서가 같은 역할을 합니다. HAProxy는 직접 서버에 설치해 세밀하게 제어하고 싶거나, 온프레미스에서 TCP·HTTP 모두를 한 도구로 다루고 싶을 때 특히 맞습니다. 선택 기준은 아래 「한계와 적용 기준 Q&A」에서 정리합니다.

## 먼저 알아둘 기반 기술

이 절은 본문을 읽는 데 필요한 지식을 가장 밑바닥(연결과 계층)부터 HAProxy 직전(TLS 종료와 가용성 개념)까지 순서대로 쌓습니다. 각 소절 끝에는 그 개념이 본문의 어느 절에서 다시 쓰이는지 적었고, 절 마지막에 전체 연결 지도를 표로 정리했습니다.

### TCP 연결과 네트워크 계층(L4와 L7)

TCP(Transmission Control Protocol, 전송 제어 프로토콜)는 두 장비가 먼저 연결을 맺고(3-way handshake, 세 번 주고받기) 데이터를 순서대로 안전하게 주고받는 방식입니다. 연결 하나는 "출발지 IP와 포트, 목적지 IP와 포트" 네 가지 값의 조합으로 구분됩니다. 네트워크는 흔히 계층으로 나누어 설명하는데, 로드밸런서 이야기에서는 두 계층이 중요합니다. L4(Layer 4, 전송 계층)는 IP 주소와 포트까지만 보고 TCP 연결을 다루는 계층이고, L7(Layer 7, 응용 계층)은 HTTP 같은 프로토콜의 내용(경로, 헤더, 쿠키)까지 이해하는 계층입니다. 택배에 비유하면 L4는 상자 겉면의 주소 라벨만 보고 분류하는 것이고, L7은 상자를 열어 내용물 목록까지 보고 분류하는 것입니다.

이 구분을 모르면 HAProxy의 `mode tcp`와 `mode http`가 왜 따로 있는지, 어떤 기능(경로별 라우팅, 쿠키 기반 세션 유지)이 HTTP 모드에서만 되는지 이해하기 어렵습니다. 확인은 `ss -tn state established` 같은 명령으로 현재 연결의 출발지·목적지 쌍을 볼 수 있습니다. 이 개념은 아래 「HAProxy 동작 구조」 절에서 모드 선택으로, 「ACL로 경로별 라우팅하기」 절에서 L7 규칙으로, 「분산 알고리즘 선택」 절에서 출발지 IP 해시의 한계로 이어집니다.

```bash
ss -tn state established '( dport = :443 or sport = :443 )' | head
# Recv-Q Send-Q Local Address:Port   Peer Address:Port
# 0      0      10.0.0.5:443        203.0.113.10:51820
```

### HTTP 요청 구조와 keep-alive

HTTP(HyperText Transfer Protocol)는 클라이언트가 요청을 보내고 서버가 응답하는 규약입니다. 요청은 메서드와 경로(`GET /api/orders`), 헤더(`Host`, `Cookie`, `X-Forwarded-For` 등), 선택적인 본문으로 이뤄지고, 응답은 상태 코드(200 성공, 502·503·504는 중간 서버 계열 오류)와 헤더·본문으로 이뤄집니다. HTTP/1.1부터는 keep-alive 덕분에 하나의 TCP 연결에서 요청을 여러 번 주고받을 수 있습니다. 즉 "연결 한 개 = 요청 한 개"가 아니라서, 연결 단위로 서버를 고르는 것과 요청 단위로 서버를 고르는 것은 결과가 다릅니다. 이 규약은 IETF(Internet Engineering Task Force)의 RFC 9110과 RFC 9112에 정의되어 있습니다.

로드밸런서가 HTTP를 이해하면 경로나 호스트 이름으로 보낼 서버 풀을 나누거나, 응답 코드가 5xx인 요청을 다른 서버로 다시 보낼 수 있습니다. 반대로 HTTP를 모르는 TCP 모드에서는 이런 판단이 불가능합니다. 또 프록시를 거치면 서버가 보는 접속자 주소가 프록시의 주소로 바뀌므로, 원래 주소를 알려 주는 `X-Forwarded-For` 헤더가 필요합니다. 이 개념은 아래 「ACL로 경로별 라우팅하기」 절의 조건식으로, 「실습 예시」 절의 `option forwardfor`로, 「문제 점검 절차」 절에서 502·503·504 코드를 구분하는 근거로 쓰입니다.

### 리버스 프록시와 로드밸런서

프록시(proxy)는 통신 당사자 사이에 끼어 대신 연결을 맺어 주는 중개자입니다. 포워드 프록시(forward proxy)는 사내 사용자를 대신해 외부로 나가는 쪽에 서고, 리버스 프록시(reverse proxy)는 서버를 대신해 외부 요청을 받는 쪽에 섭니다. 리버스 프록시가 받은 요청을 여러 서버 중 하나에 나눠 주면 그것이 곧 로드밸런서입니다. 호텔 프런트 데스크에 비유할 수 있습니다. 손님(클라이언트)은 프런트에만 말하고, 프런트가 빈 객실(서버)을 확인해 안내합니다. 객실이 수리 중이면 그 객실로는 안내하지 않습니다.

HAProxy는 요청을 받는 연결(클라이언트 쪽)과 서버로 나가는 연결(서버 쪽)을 따로 맺는 완전한 프록시입니다. 그래서 서버 쪽 연결 수를 제어하거나 느린 클라이언트로부터 서버를 보호하는 일이 가능합니다. 이 개념을 모르면 HAProxy에 `timeout client`와 `timeout server`가 따로 있는 이유를 알 수 없습니다. 이 개념은 아래 「HAProxy 동작 구조」 절에서 frontend·backend 분리로, 「문제 점검 절차」 절에서 타임아웃별 증상 구분으로 이어집니다. 앞서 소개한 Caddy나 Gateway API 글에서 다룬 리버스 프록시 개념을 이 글에서는 "서버 풀 관리"에 초점을 맞춰 다시 사용합니다.

### TLS 종료(TLS termination)

TLS(Transport Layer Security)는 통신을 암호화하고 서버 신원을 확인하는 프로토콜이며 HTTPS의 'S'에 해당합니다. TLS 종료는 로드밸런서가 클라이언트와의 암호화 연결을 직접 끝내고(복호화하고), 뒤쪽 서버와는 평문 HTTP 또는 다시 암호화한 연결로 통신하는 방식입니다. 인증서와 개인키를 로드밸런서 한 곳에서 관리할 수 있다는 장점이 있습니다. 반대로 "TLS 패스스루(passthrough)"는 로드밸런서가 복호화하지 않고 암호화된 바이트를 그대로 뒤로 넘기는 방식이며, 이 경우 로드밸런서는 HTTP 내용을 볼 수 없으므로 L4 수준의 분산만 가능합니다.

TLS를 종료해야 L7 규칙이 동작하므로, 어떤 방식을 고르느냐가 곧 쓸 수 있는 기능을 결정합니다. 인증서 만료 같은 운영 위험도 이 선택과 연결됩니다. 이 개념은 아래 「ACL로 경로별 라우팅하기」 절에서 `bind ... ssl crt` 설정과 HTTP→HTTPS 리다이렉트로, 「한계와 적용 기준 Q&A」 절에서 패스스루가 필요한 경우로 이어집니다.

### 가용성, 타임아웃, 장애 감지

가용성(availability)은 서비스가 필요할 때 쓸 수 있는 정도를 말하며, 서버를 여러 대로 두는 이중화(redundancy)가 기본 수단입니다. 이중화만으로는 부족하고 "죽은 서버를 빠르게 알아채는 감지"와 "그 서버로 요청을 보내지 않는 격리"가 있어야 합니다. 감지에는 능동적 방법(주기적으로 확인 요청을 직접 보내는 active check)과 수동적 방법(실제 요청의 실패를 관찰하는 passive check)이 있습니다. 타임아웃(timeout)은 "이 시간 안에 응답이 없으면 실패로 간주한다"는 기준이며, 너무 짧으면 정상 요청이 끊기고 너무 길면 장애 서버에 사용자가 오래 매달립니다.

이 개념을 모르면 헬스체크 설정값(`inter`, `fall`, `rise`)이 장애 감지 시간과 오탐(정상인데 죽었다고 판단)에 어떤 영향을 주는지 판단할 수 없습니다. 예를 들어 2초 간격에 3번 연속 실패하면 제외하는 설정은 최악의 경우 약 6초 이상 지나서야 서버가 풀에서 빠진다는 계산이 가능합니다. 이 개념은 아래 「헬스체크와 서버 상태 전이」 절에서 `inter`·`fall`·`rise` 계산으로, 「업무 예시: 무중단 배포」 절에서 drain 상태로 이어집니다.

### 기존 방식과 비교

| 구분 | DNS 라운드로빈만 사용 | 서버 앞 단일 Nginx 프록시 | HAProxy 서버 풀 |
|---|---|---|---|
| 분산 단위 | 이름 조회 시 주소 순서 회전 | 요청 또는 연결 | 요청 또는 연결, 알고리즘 선택 가능 |
| 죽은 서버 감지 | 없음(캐시된 주소로 계속 접속) | 수동 감지 중심 | 능동 헬스체크와 수동 감지 모두 |
| 무중단 배포 | 어려움 | 설정 reload에 의존 | drain·slowstart·런타임 API로 제어 |
| 세션 유지 | 불가 | 가능(방식 제한) | 쿠키·stick-table 등 다양 |
| 가시성 | 없음 | 로그 위주 | 통계 페이지·런타임 API·상세 종료 코드 |

위 표는 일반적인 특성을 비교한 것이며, Nginx 같은 다른 도구도 설정에 따라 능력이 달라집니다. 표의 취지는 "분산 외에 감지·격리·관측까지 한 도구가 담당한다"는 점입니다.

### 기반 개념과 본문 연결 지도

| 기반 개념 | 쓰이는 본문 절 | 그 절에서의 역할 |
|---|---|---|
| TCP 연결과 L4/L7 | HAProxy 동작 구조 | `mode tcp`와 `mode http` 선택의 근거 |
| TCP 연결과 L4/L7 | ACL로 경로별 라우팅하기 | L7 조건(경로·호스트)으로 풀 선택 |
| TCP 연결과 L4/L7 | 분산 알고리즘 선택 | 출발지 IP 해시의 한계 설명 |
| HTTP 요청 구조와 keep-alive | ACL로 경로별 라우팅하기 | 경로·헤더 기반 조건식 작성 |
| HTTP 요청 구조와 keep-alive | 실습 예시: 웹 서버 두 대 앞에 HAProxy 두기 | `X-Forwarded-For`로 원본 주소 전달 |
| HTTP 요청 구조와 keep-alive | 문제 점검 절차 | 502·503·504 구분 |
| 리버스 프록시와 로드밸런서 | HAProxy 동작 구조 | frontend·backend 분리 이해 |
| 리버스 프록시와 로드밸런서 | 문제 점검 절차 | 클라이언트·서버 쪽 타임아웃 구분 |
| TLS 종료 | ACL로 경로별 라우팅하기 | `bind ssl crt`와 HTTPS 리다이렉트 |
| TLS 종료 | 한계와 적용 기준 Q&A | 패스스루가 필요한 경우 |
| 가용성·타임아웃·장애 감지 | 헬스체크와 서버 상태 전이 | `inter`·`fall`·`rise` 감지 시간 계산 |
| 가용성·타임아웃·장애 감지 | 업무 예시: 무중단 배포 | drain으로 새 요청 차단 |

## HAProxy 동작 구조

HAProxy 설정 파일(`/etc/haproxy/haproxy.cfg`)은 크게 네 구역으로 나뉩니다. `global`은 프로세스 전체 설정(로그, 최대 연결 수, 관리 소켓), `defaults`는 이후 구역의 기본값(모드, 타임아웃), `frontend`는 클라이언트의 연결을 받는 입구(어느 주소·포트에서 듣고 어느 backend로 보낼지), `backend`는 요청을 처리할 서버 풀과 분산·헬스체크 설정입니다. 둘을 한꺼번에 쓰는 `listen` 구역도 있어 작은 설정에서 편리합니다. 앞서 기반 기술에서 본 "클라이언트 쪽 연결과 서버 쪽 연결을 따로 맺는 프록시" 구조가 바로 frontend와 backend의 분리로 나타납니다.

<figure class="article-figure"><img src="{{ '/assets/images/haproxy-lb-healthcheck-flow.svg' | relative_url }}" alt="클라이언트 요청이 frontend의 ACL을 거쳐 backend 서버 풀로 전달되고, 헬스체크가 실패한 서버를 풀에서 제외하는 HAProxy 구조"><figcaption>그림. 요청은 frontend에서 규칙으로 backend를 고르고, backend의 분산 알고리즘이 서버를 고르며, 헬스체크가 장애 서버를 풀에서 제외한다. 이미지 출처: 직접 제작</figcaption></figure>

`mode`는 `tcp`와 `http` 중 하나입니다. 기반 기술에서 본 L4/L7 구분처럼, `mode tcp`는 연결을 그대로 중계하므로 데이터베이스 접속이나 TLS 패스스루처럼 프로토콜을 몰라도 되는 경우에 쓰고, `mode http`는 HTTP를 해석하므로 경로 라우팅, 헤더 수정, 쿠키 기반 세션 유지가 가능합니다. 모드는 frontend와 backend가 같아야 하며 보통 `defaults`에 한 번 적습니다. 아래는 가장 작은 뼈대입니다.

```haproxy
global
    log /dev/log local0
    maxconn 20000
    stats socket /run/haproxy/admin.sock mode 660 level admin

defaults
    mode http
    log global
    option httplog
    timeout connect 5s
    timeout client  30s
    timeout server  30s

frontend fe_http
    bind :80
    default_backend be_web

backend be_web
    balance roundrobin
    server web1 10.0.1.11:8080 check
    server web2 10.0.1.12:8080 check
```

위 설정에서 `check`가 붙은 서버만 헬스체크 대상이 됩니다. `check`를 빼먹으면 서버가 죽어도 풀에서 빠지지 않는 것이 흔한 실수입니다. `maxconn`은 동시에 처리할 최대 연결 수이며, 값을 정하지 않으면 시스템 한계나 기본값에 따라 예상보다 일찍 새 연결이 거부될 수 있으므로 운영 전에 서버 사양과 함께 정해야 합니다.

## 분산 알고리즘 선택

`balance` 지시어가 다음 요청을 보낼 서버를 정하는 규칙을 고릅니다. 공식 문서가 설명하는 대표 알고리즘은 아래와 같습니다.

| 알고리즘 | 동작 | 잘 맞는 상황 | 주의점 |
|---|---|---|---|
| `roundrobin` | 서버에 순서대로 배분(가중치 반영) | 요청 처리 시간이 비슷한 짧은 HTTP | 요청마다 비용이 크게 다르면 편중 |
| `leastconn` | 현재 연결 수가 가장 적은 서버 선택 | 연결이 오래 유지되는 작업, 처리 시간 편차가 큰 경우 | 연결이 아주 짧은 경우 이점이 작음 |
| `source` | 클라이언트 IP를 해시해 서버 고정 | 쿠키를 못 쓰는 TCP 서비스에서 간단한 고정 | NAT 뒤 다수 사용자가 한 서버에 몰림 |
| `uri` | 요청 URI를 해시해 서버 고정 | 캐시 서버 앞에서 같은 URL을 같은 서버로 | 인기 URL에 쏠림 |
| `first` | 앞 서버부터 채워 가며 사용 | 서버 수를 동적으로 줄이고 싶을 때 | 서버별 `maxconn` 설정 필수 |

처음 시작한다면 처리 시간이 짧고 균일한 웹 요청에는 `roundrobin`, 파일 업로드·웹소켓·장시간 쿼리처럼 연결이 오래가는 서비스에는 `leastconn`이 무난한 출발점이라고 공식 문서가 설명합니다. 앞서 기반 기술에서 짚었듯이 `source` 방식은 출발지 IP만 보기 때문에, 회사 NAT 뒤의 수백 명이 모두 같은 공인 IP로 나오면 한 서버에 몰립니다. 해시 계열 알고리즘은 서버 수가 바뀌면 배정이 크게 흔들리므로, 이를 줄이려면 `hash-type consistent`(일관된 해시)를 함께 고려합니다. 가중치는 서버 성능이 다를 때 `weight`로 비율을 줍니다.

```haproxy
backend be_web
    balance leastconn
    server web1 10.0.1.11:8080 check weight 100
    server web2 10.0.1.12:8080 check weight 100
    server web3 10.0.1.13:8080 check weight 50   # 사양이 절반인 서버
```

알고리즘은 "정답 하나"가 아니라 서비스 특성에 맞춰 고르는 것이므로, 바꿀 때는 통계 페이지에서 서버별 요청 수와 현재 연결 수가 어떻게 달라지는지 시험 환경에서 먼저 관찰하는 것이 안전합니다.

## 헬스체크와 서버 상태 전이

`server` 줄에 `check`를 쓰면 HAProxy가 주기적으로 서버에 확인 요청을 보냅니다. 기본은 TCP 연결이 되는지만 보는 L4 체크입니다. 하지만 포트가 열려 있어도 애플리케이션이 내부적으로 고장 난 경우가 많으므로, HTTP 서비스에는 L7 체크를 쓰는 것이 일반적입니다. 아래처럼 `option httpchk`와 `http-check` 지시어로 어떤 경로를 어떻게 요청하고 어떤 응답을 정상으로 볼지 정합니다.

```haproxy
backend be_web
    balance leastconn
    option httpchk
    http-check send meth GET uri /healthz ver HTTP/1.1 hdr Host app.example.com
    http-check expect status 200
    default-server inter 2s fall 3 rise 2 slowstart 30s
    server web1 10.0.1.11:8080 check
    server web2 10.0.1.12:8080 check
```

각 옵션은 이렇게 읽습니다. `inter 2s`는 점검 간격, `fall 3`은 연속 3번 실패하면 DOWN으로 판정, `rise 2`는 연속 2번 성공하면 다시 UP으로 판정, `slowstart 30s`는 복귀한 서버에 30초에 걸쳐 점차 요청 비중을 늘리라는 뜻입니다. 앞서 기반 기술에서 본 감지 시간 계산을 적용하면, 서버가 갑자기 죽은 경우 최대 약 `inter × fall` = 6초(점검 타이밍과 타임아웃에 따라 더 길 수 있음) 동안은 요청이 그 서버로 갈 수 있습니다. 그 사이의 요청은 `retries`와 `option redispatch` 설정으로 다른 서버에 다시 시도하게 할 수 있습니다. 반대로 `fall`을 1로 낮추면 감지는 빠르지만 일시적인 지연 한 번에도 서버가 빠지는 오탐이 늘어납니다. `slowstart`는 방금 켜진 서버가 캐시가 비어 있어 느린데도 평균적인 몫의 요청을 받아 다시 쓰러지는 일을 줄입니다.

헬스체크 엔드포인트 설계도 중요합니다. `/healthz`가 항상 200만 돌려주는 단순 응답이면 데이터베이스 연결이 끊긴 서버도 정상으로 보입니다. 반대로 외부 의존성(DB, 외부 API)까지 모두 확인하게 만들면 DB 장애 때 모든 서버가 동시에 DOWN이 되어 풀이 통째로 비는 연쇄 장애가 날 수 있습니다. 보통 "이 프로세스가 요청을 처리할 준비가 됐는가"를 확인하는 가벼운 점검과, 깊은 점검을 별도 경로로 분리하는 방식이 권장됩니다.

능동 점검 외에 수동 점검도 설정할 수 있습니다. `observe layer7`과 `error-limit`, `on-error` 옵션을 함께 쓰면 실제 사용자 요청에서 관찰된 오류가 일정 횟수를 넘을 때 서버를 의심 상태로 보고 조치할 수 있습니다. 능동 점검은 트래픽이 없어도 상태를 알 수 있다는 장점이 있고, 수동 점검은 점검 경로가 놓치는 실제 요청 실패를 잡는다는 장점이 있어 서로 보완합니다. 다만 수동 점검을 공격적으로 설정하면 특정 요청 하나가 계속 오류를 일으킬 때 멀쩡한 서버까지 빠질 수 있으므로, 처음에는 능동 점검만으로 시작하고 필요가 확인된 뒤에 단계적으로 추가하는 편이 안전합니다. 설정값을 바꾼 뒤에는 서버 한 대를 일부러 멈추거나 점검 경로가 500을 돌려주게 만들어, 통계 페이지에서 상태가 실제로 DOWN으로 바뀌고 다시 UP으로 돌아오는 시간을 직접 관찰해 두세요. 이런 장애 주입 확인은 설정을 믿기 전에 가장 값싸게 할 수 있는 검증입니다.

서버 상태는 아래 표처럼 전이합니다.

| 상태 | 의미 | 새 요청 | 기존 연결 |
|---|---|---|---|
| UP | 정상 | 받음 | 유지 |
| DOWN | 헬스체크 실패로 제외 | 받지 않음 | 기본은 유지, `on-marked-down shutdown-sessions` 설정 시 종료 |
| DRAIN | 운영자가 새 요청만 차단 | 받지 않음(고정 세션 제외 규칙은 문서 확인) | 끝날 때까지 유지 |
| MAINT | 점검 모드 | 받지 않음 | 정책에 따름 |

`DRAIN`은 다음 절 이후의 무중단 배포에서 핵심이 됩니다.

## 실습 예시: 웹 서버 두 대 앞에 HAProxy 두기

여기서는 한 대의 리눅스 서버에 HAProxy를 설치하고 뒤쪽 웹 서버 두 대로 분산하는 최소 실습을 정리합니다. 패키지 이름과 경로는 배포판마다 다를 수 있으니 사용하는 배포판 문서를 함께 확인하세요.

1단계는 설치와 버전 확인입니다.

```bash
sudo apt-get update && sudo apt-get install -y haproxy socat   # Debian/Ubuntu 계열 예시
haproxy -v
# HAProxy version 2.x.x ... (버전 출력)
```

2단계는 설정 파일 작성입니다. 아래는 TLS 없이 시작하는 HTTP 분산 예시이며, 원래 접속자 주소를 서버로 알리는 `option forwardfor`를 포함합니다. 기반 기술에서 본 것처럼 프록시를 거치면 서버가 보는 출발지가 HAProxy의 주소가 되기 때문입니다.

```haproxy
defaults
    mode http
    log global
    option httplog
    option forwardfor
    option redispatch
    retries 3
    timeout connect 5s
    timeout client  30s
    timeout server  30s
    timeout queue   10s

frontend fe_http
    bind :80
    default_backend be_web

backend be_web
    balance roundrobin
    option httpchk
    http-check send meth GET uri /healthz
    http-check expect status 200
    default-server inter 2s fall 3 rise 2
    server web1 10.0.1.11:8080 check maxconn 200
    server web2 10.0.1.12:8080 check maxconn 200
```

3단계는 문법 검사와 적용입니다. 문법 검사를 통과하기 전에는 절대 reload하지 않는 것이 습관이 되어야 합니다.

```bash
sudo haproxy -c -f /etc/haproxy/haproxy.cfg
# Configuration file is valid
sudo systemctl reload haproxy        # 기존 연결을 끊지 않고 새 설정의 워커 시작
curl -i http://127.0.0.1/            # 응답 확인
```

`reload`는 새 설정으로 새 워커 프로세스를 띄우고 기존 워커는 진행 중인 연결이 끝날 때까지 남겨 두는 방식으로 동작하므로, 대부분의 경우 사용자 연결을 끊지 않고 설정을 바꿀 수 있습니다. 장시간 유지되는 연결이 많으면 오래된 워커가 오래 남을 수 있어 `hard-stop-after` 같은 설정을 검토합니다. 마지막으로 `maxconn 200`처럼 서버별 최대 연결을 두면, 한계를 넘는 요청은 HAProxy의 대기열에서 `timeout queue`만큼 기다리다 처리됩니다. 서버를 과부하로부터 보호하는 완충 장치입니다.

## ACL로 경로별 라우팅하기

ACL(Access Control List, 접근 제어 목록)은 HAProxy에서 "조건에 이름을 붙이는" 문법입니다. 요청 경로, 호스트 이름, 헤더, 출발지 주소 등을 검사해 참·거짓을 만들고, 그 이름을 `use_backend`나 `http-request` 규칙에서 조건으로 씁니다. 기반 기술에서 본 HTTP 요청 구조(경로·`Host` 헤더)가 이 조건의 재료입니다. 아래는 TLS 종료, HTTP를 HTTPS로 돌려보내는 리다이렉트, `/api` 경로는 API 서버 풀로 나누는 예시입니다.

```haproxy
frontend fe_https
    bind :80
    bind :443 ssl crt /etc/haproxy/certs/app.example.com.pem alpn h2,http/1.1
    http-request redirect scheme https unless { ssl_fc }
    http-request set-header X-Forwarded-Proto https if { ssl_fc }

    acl is_api  path_beg /api
    acl is_admin hdr(host) -i admin.example.com

    use_backend be_api   if is_api
    use_backend be_admin if is_admin
    default_backend be_web
```

`bind ... ssl crt`가 기반 기술에서 설명한 TLS 종료 설정입니다. 인증서 파일은 보통 인증서 체인과 개인키를 하나의 PEM 파일로 이어 붙인 것이며, 개인키가 들어 있으므로 파일 권한을 `600`처럼 좁혀야 합니다. `ssl_fc`는 "프런트엔드 연결이 TLS인가"를 판별하는 조건이고, `unless { ssl_fc }`는 TLS가 아닐 때만 리다이렉트하라는 뜻입니다. `alpn h2,http/1.1`은 클라이언트와 HTTP/2를 쓸 수 있게 협상하는 설정입니다. 인증서는 만료 전에 갱신하고 reload로 반영해야 하므로, 만료일을 감시하는 알림이 필요합니다. 만료일은 다음처럼 확인할 수 있습니다.

```bash
openssl x509 -in /etc/haproxy/certs/app.example.com.pem -noout -enddate
# notAfter=Mar  1 00:00:00 2027 GMT
```

ACL 규칙은 위에서 아래로 평가되고 `use_backend`는 먼저 일치한 것이 적용되므로, 구체적인 규칙을 위에 두고 포괄적인 규칙을 아래에 둡니다. 어느 규칙에도 맞지 않는 요청은 `default_backend`로 갑니다. 이 기본값을 빼먹으면 매칭되지 않은 요청이 503 오류를 받습니다.

## 세션 유지와 stick-table

로그인 상태를 서버 메모리에 보관하는 애플리케이션은 같은 사용자의 요청이 같은 서버로 가야 합니다. 이를 세션 유지(session persistence, 스티키 세션)라고 합니다. 가장 좋은 해결은 세션을 Redis 같은 공유 저장소로 빼서 서버를 무상태(stateless)로 만드는 것이지만, 당장 어렵다면 HAProxy에서 두 가지 방법을 쓸 수 있습니다. 첫째는 쿠키를 삽입하는 방식으로, HAProxy가 응답에 서버 식별 쿠키를 넣고 이후 요청의 쿠키를 보고 같은 서버로 보냅니다.

```haproxy
backend be_web
    balance roundrobin
    cookie SRV insert indirect nocache
    server web1 10.0.1.11:8080 check cookie w1
    server web2 10.0.1.12:8080 check cookie w2
```

둘째는 stick-table(스틱 테이블)입니다. 키(예: 클라이언트 IP)와 값(서버 ID)을 메모리 표에 저장해 두는 HAProxy 내장 저장소로, 기반 기술에서 본 출발지 IP 해시보다 유연합니다. 서버가 DOWN이 되면 해당 항목은 다른 서버로 옮겨집니다.

```haproxy
backend be_web
    balance roundrobin
    stick-table type ip size 100k expire 30m
    stick on src
    server web1 10.0.1.11:8080 check
    server web2 10.0.1.12:8080 check
```

stick-table은 요청 속도 제한(rate limiting)에도 쓰이는 범용 기능이므로 공식 문서의 해당 장을 읽어 보세요. 세션 유지는 부하 편중, 서버 장애 시 세션 손실이라는 비용이 있으므로 "필요한 경우에만" 쓰는 것이 원칙입니다.

## 상태 확인과 런타임 API

운영 중에는 설정 파일을 고치지 않고도 서버 상태를 보고 바꿀 수 있어야 합니다. 이를 위해 `global`에서 연 `stats socket`이 런타임 API(Runtime API) 통로이며, 아래처럼 `socat`으로 명령을 보냅니다. 소켓에 `level admin` 권한을 주면 서버 상태까지 바꿀 수 있으므로 접근 권한을 반드시 제한해야 합니다.

```bash
echo "show info" | sudo socat stdio /run/haproxy/admin.sock | head
echo "show servers state be_web" | sudo socat stdio /run/haproxy/admin.sock
# 1 be_web 1 web1 10.0.1.11 2 0 1 1 ...
echo "show stat" | sudo socat stdio /run/haproxy/admin.sock | cut -d, -f1,2,18 | head
# be_web,web1,UP
# be_web,web2,UP
```

사람이 보는 화면이 필요하면 통계 페이지를 로컬 주소에만 엽니다. 외부에 노출하면 내부 구조가 드러나므로 인증과 접근 제한을 반드시 둡니다.

```haproxy
listen stats
    bind 127.0.0.1:8404
    stats enable
    stats uri /stats
    stats refresh 10s
```

통계에서 볼 핵심 지표는 서버별 상태, 현재 세션 수, 대기열 길이, 5xx 응답 수, 연결 오류 수입니다. 대기열이 지속적으로 쌓이면 서버 용량이나 `maxconn` 설정이 부족하다는 신호입니다.

## 업무 예시: 무중단 배포

다음은 문서의 기능을 조합한 가상의 시나리오입니다. 직접 운영한 사례가 아니라 절차를 설명하기 위한 예시입니다. 서버 두 대(web1, web2)에 새 버전을 배포하되 사용자 요청이 끊기지 않아야 합니다. 앞서 기반 기술에서 본 장애 감지 개념에서 한 단계 나아가, 의도적으로 서버를 빼는 절차입니다. 순서는 아래와 같습니다.

1. web1을 `drain`으로 바꿔 새 요청이 가지 않게 합니다.
2. 통계에서 web1의 현재 세션이 0에 가까워질 때까지 기다립니다.
3. web1에 배포하고 `/healthz`가 200을 돌려주는지 직접 확인합니다.
4. web1을 `ready`로 되돌립니다. `slowstart`가 있다면 점진적으로 비중이 늘어납니다.
5. web2에도 같은 순서를 반복합니다.

```bash
SOCK=/run/haproxy/admin.sock
echo "set server be_web/web1 state drain" | sudo socat stdio $SOCK
echo "show stat" | sudo socat stdio $SOCK | awk -F, '$2=="web1"{print "scur="$5, "status="$18}'
# scur=0 status=DRAIN        <- 현재 세션 0이면 배포 가능
# ... web1 배포 ...
curl -fsS http://10.0.1.11:8080/healthz && echo ready-check-ok
echo "set server be_web/web1 state ready" | sudo socat stdio $SOCK
```

이 절차의 장점은 사용자 요청이 서버 재시작 시점에 걸리지 않는다는 것입니다. 한 번에 한 대씩만 빼므로 남은 서버가 부하를 감당할 수 있는지 미리 계산해야 합니다. 서버가 두 대뿐인데 한 대가 평소 부하의 60%를 이미 받고 있다면 한 대로는 버티지 못하므로, 배포 시간대를 조정하거나 서버를 늘려야 합니다. 런타임 API로 바꾼 상태는 reload나 재시작 시 설정 파일 기준으로 돌아가므로, 영구 변경이 필요하면 설정 파일도 고쳐야 합니다.

## 문제 점검 절차

증상은 대개 HTTP 상태 코드로 시작합니다. 기반 기술에서 본 상태 코드 구분을 HAProxy에 적용하면 아래 표와 같습니다.

| 증상 | 가능한 원인 | 먼저 볼 것 |
|---|---|---|
| 503 Service Unavailable | 풀에 UP 서버가 없음, 대기열 시간 초과, 매칭되는 backend 없음 | `show stat`의 서버 상태, 헬스체크 경로 응답 |
| 502 Bad Gateway | 서버가 잘못된 응답을 보냈거나 연결을 끊음 | 서버 애플리케이션 로그, 서버 쪽 타임아웃 |
| 504 Gateway Timeout | 서버가 `timeout server` 안에 응답하지 않음 | 느린 쿼리, 서버 처리 시간 |
| 클라이언트 연결 끊김 | `timeout client` 초과 또는 클라이언트 중단 | 로그의 종료 상태 코드 |

HAProxy의 HTTP 로그 형식(`option httplog`)에는 종료 상태(termination state) 네 글자가 들어 있어 원인을 좁히는 데 큰 도움이 됩니다. 첫 글자는 세션 종료 원인으로, 예를 들어 `c`는 클라이언트 쪽 타임아웃, `s`는 서버 쪽 타임아웃, `C`는 클라이언트가 중단, `S`는 서버가 연결을 거부하거나 중단한 경우입니다. 두 번째 글자는 종료 시점의 단계로 `R`은 요청 수신 중, `Q`는 대기열, `C`는 서버 연결 중, `H`는 응답 헤더 대기 중, `D`는 데이터 전송 중입니다. 즉 `sH`는 서버가 응답 헤더를 보내기 전에 서버 타임아웃이 났다는 뜻이고, `SC`는 서버 연결 단계에서 거부당했다는 뜻입니다. 정확한 전체 표는 공식 문서의 로깅 장에 있으므로 함께 보세요.

```bash
sudo journalctl -u haproxy --since "10 min ago" | grep -E ' 50[234] ' | tail -5
# ... be_web/web2 0/0/-1/-1/5001 503 ... SC-- ...    <- 서버 연결 거부(SC)
sudo ss -ltnp | grep -E ':80|:443'                    # HAProxy가 듣고 있는지
curl -sv -H 'Host: app.example.com' http://10.0.1.11:8080/healthz   # 서버 직접 확인
```

헬스체크는 통과하는데 사용자는 오류를 겪는다면 헬스체크 경로가 실제 사용자 경로와 다른 기능만 확인하고 있을 가능성이 큽니다. 반대로 헬스체크가 실패하는데 사용자는 정상이라면 `Host` 헤더 누락처럼 체크 요청 자체의 문제일 수 있으므로 위 `curl`로 같은 요청을 직접 재현해 보세요.

## 한계와 적용 기준 Q&A

### Q. HAProxy 자체가 단일 장애 지점(SPOF)이 되지 않나요?

A. 그렇습니다. 로드밸런서 한 대가 죽으면 서비스 전체가 멈춥니다. 그래서 보통 HAProxy를 두 대 이상 두고 Keepalived 같은 도구의 VRRP(Virtual Router Redundancy Protocol, 가상 라우터 이중화 프로토콜)로 가상 IP를 넘기거나, 클라우드의 상위 로드밸런서 또는 DNS 수준의 장애 전환과 조합합니다. 이 글은 이중화 구성 자체는 다루지 않았으므로 공식 문서와 해당 도구 문서를 별도로 확인하세요.

### Q. TLS를 로드밸런서에서 종료해도 안전한가요?

A. 로드밸런서 뒤 구간이 평문이 되므로 그 구간이 신뢰할 수 있는 내부망인지 판단해야 합니다. 규정상 구간 전체 암호화가 필요하면 서버 쪽에도 `ssl` 옵션으로 재암호화하거나, L4 패스스루로 서버가 직접 TLS를 종료하게 해야 합니다. 패스스루를 쓰면 경로 라우팅과 같은 L7 기능은 쓰지 못합니다.

### Q. 헬스체크 간격을 짧게 하면 항상 좋은가요?

A. 아닙니다. 간격이 짧으면 장애 감지는 빨라지지만 서버가 받는 점검 요청이 늘고, 일시적 지연에도 오탐이 늘어납니다. 서버 수가 많을수록 점검 트래픽도 합산됩니다. `inter`와 `fall`·`rise`를 서비스 허용 장애 시간과 오탐 허용도에 맞춰 함께 정하고 시험 환경에서 확인하세요.

### Q. Nginx나 클라우드 로드밸런서와 비교해 언제 HAProxy를 고르나요?

A. 이미 클라우드 관리형 로드밸런서를 쓰고 있고 요구가 단순하다면 관리형이 운영 부담이 적습니다. HAProxy는 TCP와 HTTP를 한 도구로 다루고, 세밀한 헬스체크·종료 상태 로그·런타임 API가 필요한 온프레미스나 직접 제어 환경에서 강점이 있습니다. 어떤 도구가 항상 더 빠르다고 단정하지 말고 자신의 부하 조건에서 측정해 비교하세요.

### Q. 도입 전 체크리스트가 있나요?

A. 아래 항목을 확인하면 대부분의 초기 실수를 피할 수 있습니다.

- 모든 `server` 줄에 `check`가 있고 헬스체크 경로가 실제 동작을 대표하는가
- `timeout connect`, `client`, `server`, `queue`가 명시되어 있는가
- 서버별 `maxconn`과 전체 `maxconn`이 서버 사양에 맞는가
- `haproxy -c` 문법 검사를 배포 절차에 넣었는가
- 런타임 소켓과 통계 페이지에 접근 제한이 있는가
- 인증서 만료일 감시와 갱신 후 reload 절차가 있는가
- HAProxy 자체의 이중화 계획이 있는가

## 마무리

HAProxy의 핵심은 "frontend에서 받고, ACL로 가르고, backend에서 서버를 골라 보내며, 헬스체크로 풀을 스스로 정리한다"는 흐름입니다. 분산 알고리즘은 서비스 특성에 맞춰 고르고, 헬스체크는 감지 속도와 오탐 사이에서 균형을 잡으며, 런타임 API의 `drain`으로 배포를 부드럽게 만드는 것이 운영의 기본기입니다. 처음에는 서버 두 대와 짧은 설정으로 시작해 통계 페이지와 로그의 종료 상태 코드를 읽는 연습부터 해 보세요.

<h3 class="references-heading">참고 자료</h3>

- [HAProxy 공식 사이트](https://www.haproxy.org/)
- [HAProxy 공식 문서 모음](https://docs.haproxy.org/)
- [HAProxy Starter Guide (소개 문서)](https://docs.haproxy.org/3.0/intro.html)
- [HAProxy Configuration Manual](https://docs.haproxy.org/3.0/configuration.html)
- [HAProxy Management Guide (런타임 API 포함)](https://docs.haproxy.org/3.0/management.html)
- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110)
- [RFC 9112: HTTP/1.1](https://www.rfc-editor.org/rfc/rfc9112)
- [RFC 8446: TLS 1.3](https://www.rfc-editor.org/rfc/rfc8446)
