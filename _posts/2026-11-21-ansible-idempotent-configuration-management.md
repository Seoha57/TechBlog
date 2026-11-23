---
layout: post
title: "Ansible로 서버 설정을 멱등하게 관리하기: 인벤토리·플레이북·핸들러·check 모드 입문"
categories: [Infrastructure]
tags: [infrastructure, ansible, configuration-management, idempotency, playbook, inventory, automation]
description: "Ansible(앤서블)의 에이전트 없는 구조와 멱등성, 인벤토리·플레이북·핸들러·check 모드를 서버 설정 업무 예시와 실행 결과 예시로 처음 접하는 독자도 이해하도록 설명합니다."
last_modified_at: 2026-11-23 12:00:00 +0900
---
{% raw %}

## 먼저 답하기

### Q. Ansible은 무엇이고 왜 쓰나요?

A. Ansible(앤서블)은 여러 서버의 설정을 코드로 적어 두고 일괄 적용하는 구성 관리(configuration management) 도구입니다. 서버가 세 대일 때는 사람이 SSH(Secure Shell, 원격 보안 접속)로 들어가 명령을 입력해도 되지만, 서버가 서른 대가 되면 "어느 서버는 패키지 버전이 다르고, 어느 서버는 설정 파일이 수작업으로 고쳐져 있는" 상태가 금방 생깁니다. 이런 서버 간 차이를 설정 드리프트(configuration drift)라고 부릅니다. Ansible은 "이 서버는 이런 상태여야 한다"는 목표를 YAML(YAML Ain't Markup Language, 들여쓰기로 구조를 표현하는 텍스트 형식) 파일로 적고, 그 상태에 맞도록 서버를 맞춰 줍니다. 대상 서버에 별도의 에이전트(agent, 상주 프로그램)를 설치하지 않고 SSH와 파이썬만으로 동작하는 점이 큰 특징입니다.

### Q. 멱등성(idempotency)이 무슨 뜻이고 왜 중요한가요?

A. 멱등성은 "같은 작업을 몇 번 반복해도 결과가 같다"는 성질입니다. 전등 스위치 중 "켜기" 전용 버튼을 생각해 보세요. 이미 켜져 있을 때 한 번 더 눌러도 여전히 켜져 있을 뿐 아무 일도 일어나지 않습니다. 반대로 "토글" 스위치는 누를 때마다 상태가 바뀌므로 멱등하지 않습니다. 셸 스크립트의 `echo "listen 8080" >> nginx.conf`는 실행할 때마다 줄이 하나씩 추가되어 멱등하지 않지만, Ansible의 `lineinfile` 모듈은 "이 줄이 파일에 있어야 한다"는 목표를 선언하므로 이미 있으면 아무것도 하지 않습니다. 멱등성이 있어야 플레이북을 정기적으로 다시 돌려 드리프트를 교정할 수 있고, 중간에 실패한 작업을 처음부터 다시 실행해도 안전합니다.

### Q. 언제 쓰면 좋고 언제 피해야 하나요?

A. 서버 수십 대의 패키지·설정 파일·서비스 상태·사용자 계정을 같은 규칙으로 맞춰야 할 때, 신규 서버 초기 설정을 재현 가능하게 만들고 싶을 때 잘 맞습니다. 반대로 서버 한 대를 한 번만 만지는 일회성 작업이라면 도구를 배우는 비용이 더 큽니다. 또 수천 대 규모에서 실시간으로 상태를 지속 감시하고 되돌리는 일이나 컨테이너 이미지 안의 설정은 다른 도구(쿠버네티스 매니페스트, 이미지 빌드 파이프라인)가 더 자연스럽습니다. 이 글의 명령과 출력은 공식 문서 내용을 학습용으로 풀어 쓴 예시이며, 제가 실제 서버에서 실행해 측정한 결과가 아닙니다. 적용 전에는 반드시 테스트 환경에서 `--check`와 실제 실행을 검증해야 합니다.

## 먼저 알아둘 기반 기술

이 절은 본문을 읽는 데 필요한 사전 지식을 가장 밑바닥부터 차례로 쌓습니다. 리눅스 서버를 다루는 기본기에서 출발해 원격 접속, 설정 파일 형식, 템플릿, 협업 도구, 무중단 배포 개념을 거쳐 Ansible의 핵심인 선언형과 멱등성까지 올라갑니다. 각 소절 끝에는 그 개념이 본문의 어느 절에서 다시 쓰이는지 적어 두었습니다.

### 리눅스 서버 관리의 기본: 패키지, 서비스, 권한

리눅스 서버를 관리한다는 것은 대부분 세 가지 일을 반복하는 것입니다. 첫째는 패키지 관리자(package manager)로 프로그램을 설치하는 일입니다. 패키지 관리자는 스마트폰의 앱 스토어처럼 프로그램과 그 의존 파일을 한 번에 내려받아 설치해 주는 도구로, 데비안·우분투 계열은 `apt`, 레드햇·로키 리눅스 계열은 `dnf`를 씁니다. 둘째는 서비스(service)를 관리하는 일입니다. 웹 서버처럼 백그라운드에서 계속 실행되는 프로그램을 서비스라고 하며, 대부분의 배포판은 systemd(시스템디, 서비스를 시작·중지·자동 시작 등록하는 관리자)를 씁니다. 셋째는 권한(permission)을 다루는 일입니다. 시스템 설정 파일은 관리자 계정인 root만 고칠 수 있어서, 일반 계정은 sudo(superuser do, 잠시 관리자 권한을 빌려 명령을 실행하는 도구)를 앞에 붙여 실행합니다. 파일마다 소유자와 접근 권한이 있는데, `0644`는 "소유자는 읽기·쓰기, 나머지는 읽기만"이라는 숫자 표기입니다.

```bash
sudo apt install -y nginx        # 패키지 설치(데비안 계열)
sudo systemctl enable --now nginx  # 서비스 자동 시작 등록과 즉시 시작
sudo nginx -t                    # 설정 파일 문법 검사
sudo systemctl reload nginx      # 연결을 끊지 않고 설정만 다시 읽기
ls -l /etc/nginx/nginx.conf      # -rw-r--r-- root root : 0644 권한
```

이 글에 이 개념이 필요한 이유는 Ansible 모듈이 결국 이 작업들을 대신 수행하기 때문입니다. `package` 모듈은 apt나 dnf를, `service` 모듈은 systemctl을, `become`은 sudo를, `mode: "0644"`는 chmod를 코드로 옮긴 것입니다. 특히 서비스의 재시작(restart, 프로세스를 끄고 다시 켬)과 재적재(reload, 프로세스는 유지한 채 설정만 다시 읽음)의 차이를 알아야 핸들러가 왜 `reloaded`를 쓰는지 이해할 수 있습니다. 이 개념은 아래 「핵심 구성 요소」 절에서 모듈과 `become`, `validate: "nginx -t -c %s"`를 읽을 때, 「핸들러: 변경이 있을 때만 한 번 실행」 절에서 서비스 재적재를 이해할 때, 「팩트 수집과 운영체제별 분기」 절에서 배포판마다 패키지 이름이 달라지는 이유를 이해할 때 쓰입니다. 「흔한 실수와 점검표」 절의 "필요한 태스크에만 `become`을 건다"는 최소 권한 원칙도 이 권한 개념 위에 서 있습니다.

### SSH와 제어 노드, 관리 노드

SSH(Secure Shell)는 네트워크 너머의 서버에 암호화된 통로로 접속해 명령을 실행하는 프로토콜입니다. 집 밖에서 현관 도어락을 원격으로 여는 것처럼, 내 컴퓨터에서 `ssh deploy@web01.example.internal` 한 줄로 원격 서버의 셸을 얻습니다. Ansible을 실행하는 컴퓨터를 제어 노드(control node), 설정을 적용받는 서버를 관리 노드(managed node)라고 합니다. 제어 노드는 SSH로 관리 노드에 접속해 작은 파이썬 프로그램(모듈)을 임시로 올려 실행하고, 결과를 JSON(JavaScript Object Notation, 키와 값으로 데이터를 표현하는 텍스트 형식)으로 돌려받은 뒤 임시 파일을 지웁니다. 예를 들어 모듈은 `{"changed": true, "msg": "..."}` 같은 JSON을 돌려주고, Ansible은 이 `changed` 값을 보고 화면에 `ok`나 `changed`를 표시합니다. 그래서 관리 노드에는 SSH 접속과 파이썬 인터프리터만 있으면 됩니다.

접속은 비밀번호보다 공개키 인증을 권장합니다. 제어 노드의 개인키로 서명하고 관리 노드의 `~/.ssh/authorized_keys`에 등록된 공개키로 검증하는 방식이라, 비밀번호를 파일에 적어 둘 필요가 없습니다. 이 구조를 알아야 하는 이유는 Ansible 오류의 상당수가 "모듈이 틀려서"가 아니라 "SSH 접속이 안 되거나 파이썬 경로가 달라서" 생기기 때문입니다. 또 서버마다 SSH 연결을 새로 맺는 구조라서 서버 수가 많아지면 실행 시간이 늘어난다는 한계도 여기서 나옵니다. 이 개념은 아래 「인벤토리: 누구에게 적용할 것인가」 절의 `ansible_user`, `ansible_python_interpreter` 변수와, 「문법 검사와 린트」 절의 `ping` 모듈(ICMP 핑이 아니라 SSH와 파이썬 점검)에서 쓰이며, 「롤링 배포: 한 번에 몇 대씩」 절의 `delegate_to: localhost`처럼 "어느 쪽 컴퓨터에서 실행하는가"를 구분할 때도 필요합니다.

### YAML 문법의 최소 지식

YAML(YAML Ain't Markup Language)은 들여쓰기로 데이터 구조를 표현하는 텍스트 형식입니다. 장보기 메모를 "과일 아래에 사과, 배"처럼 들여 써서 정리하는 것과 비슷합니다. Ansible 코드는 거의 전부 YAML입니다. 핵심 규칙은 세 가지입니다. 첫째, 들여쓰기는 공백으로만 하고 탭을 쓰면 안 됩니다. 둘째, `key: value`는 사전(dictionary), 줄 앞의 `- `는 목록(list) 항목입니다. 셋째, 콜론이나 중괄호가 값에 들어가면 따옴표로 감싸야 합니다. 예를 들어 `{{ var }}`처럼 중괄호로 시작하는 값은 `"{{ var }}"`처럼 따옴표 안에 넣습니다.

```yaml
fruits:            # 사전의 키
  - apple          # 목록 항목
  - pear
owner: root        # key: value
mode: "0644"       # 숫자로 오해되지 않도록 따옴표
```

이 지식이 필요한 이유는 플레이북의 구조 자체가 "목록 안의 사전 안의 목록"이기 때문입니다. 들여쓰기 한 칸 차이로 `notify`가 태스크가 아니라 모듈 인자로 들어가 버리는 식의 실수가 생기고, 오류 메시지는 그 결과만 보여 줍니다. 편집기에서 공백 표시를 켜고 `ansible-playbook --syntax-check`로 문법을 먼저 확인하는 습관이 좋습니다. 이 개념은 아래 「플레이북, 플레이, 태스크」 절의 플레이북 구조, 「변수와 우선순위」 절의 `group_vars` 파일, 「컬렉션과 의존성 고정」 절의 `requirements.yml`을 읽을 때 그대로 쓰입니다.

### Jinja2 템플릿과 변수 치환

템플릿(template)은 빈칸이 뚫린 서식 문서입니다. 상장 양식에 이름과 날짜만 바꿔 넣듯, 설정 파일의 틀은 그대로 두고 서버마다 다른 값만 채워 넣습니다. Jinja2(진자 투)는 파이썬 생태계에서 널리 쓰이는 템플릿 엔진으로, 변수는 이중 중괄호로, 반복과 조건은 중괄호와 퍼센트 기호로 표현합니다. 필터(filter)는 값 뒤에 `|`를 붙여 변환하는 기능입니다.

```jinja
listen {{ http_port }};                  {# http_port: 8080 이면 "listen 8080;" #}
server_name {{ inventory_hostname }};    {# 접속 대상 호스트 이름 #}
{% if enable_gzip %}gzip on;{% endif %}
user_count = {{ users | length }}        {# 필터로 목록 길이 계산 #}
```

이 개념이 필요한 이유는 Ansible이 설정 파일뿐 아니라 플레이북 안의 값에도 Jinja2를 쓰기 때문입니다. URL 안의 호스트 이름, 운영체제에 따라 달라지는 패키지 이름, 비밀번호 해시 변환까지 모두 이 문법으로 표현됩니다. 이 문법을 모르면 따옴표 안의 이중 중괄호가 무엇을 뜻하는지 읽을 수 없습니다. 이 개념은 아래 「Jinja2 템플릿」 절의 `nginx.conf.j2`, 「롤링 배포: 한 번에 몇 대씩」 절의 `inventory_hostname` 치환, 「Ansible Vault」 절의 `password_hash` 필터, 「팩트 수집과 운영체제별 분기」 절의 조건식에서 쓰입니다.

### 코드 저장소와 CI: 인프라를 코드로 관리하기

Git은 파일의 변경 이력을 기록하는 버전 관리 시스템입니다. 문서 편집기의 "변경 내용 추적" 기능을 프로젝트 전체에 적용한 것과 비슷해서, 누가 언제 무엇을 왜 바꿨는지 커밋(commit) 단위로 남습니다. CI(Continuous Integration, 지속적 통합)는 변경이 올라올 때마다 자동으로 검사를 돌리는 체계이고, cron은 리눅스에서 정해진 시각에 명령을 실행하는 스케줄러입니다. 예를 들어 `0 6 * * 1 /opt/ops/drift-check.sh`라는 cron 항목은 "매주 월요일 06시에 점검 스크립트 실행"을 뜻합니다. 서버 설정을 이런 도구로 관리하는 접근을 IaC(Infrastructure as Code, 코드로서의 인프라)라고 부릅니다.

이 개념이 이 글에 필요한 이유는 Ansible의 가치 상당 부분이 "설정이 코드가 된다"는 데서 나오기 때문입니다. 코드가 되면 검토와 이력, 자동 검사, 재사용이 가능해집니다. 반대로 비밀번호를 평문으로 커밋하면 이력에 영원히 남는다는 위험도 생기며, 이것이 볼트가 필요한 이유입니다. 이 개념은 아래 「문법 검사와 린트」 절의 CI 연동, 「도입 순서」 절의 Git 저장소 관리, 「롤: 재사용 가능한 묶음」 절의 재사용 구조, 「비밀 정보 다루기」 절의 평문 비밀 유출 위험, 「변경 관리와 이력」 절과 「실행 이력의 활용과 정기 점검 예시」 절의 cron 기반 정기 점검, 그리고 「구성 관리 도구 선택 기준」 절에서 OpenTofu 같은 다른 IaC 도구와 역할을 비교할 때 쓰입니다.

### 로드밸런서와 헬스체크

로드밸런서(load balancer)는 들어오는 요청을 여러 서버에 나눠 보내는 장치나 소프트웨어입니다. 은행 창구 안내원이 손님을 비어 있는 창구로 보내는 것과 같습니다. 헬스체크(health check)는 서버가 정상 응답하는지 주기적으로 확인하는 요청입니다. 흔히 `/healthz` 같은 주소에 요청을 보내 HTTP 상태 코드 200(정상)이 오면 살아 있다고 판단합니다.

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://web01.example.internal/healthz
# 200 이면 정상, 그 외(예: 502, 연결 실패)면 풀에서 빼야 할 후보
```

이 개념이 필요한 이유는 운영 중인 웹 서버의 설정을 바꿀 때 사용자가 오류를 겪지 않게 하려면 "한 대를 풀에서 빼고, 바꾸고, 헬스체크로 확인하고, 다시 넣는" 순서를 지켜야 하기 때문입니다. 이 흐름을 모르면 플레이북의 `pre_tasks`와 `post_tasks`가 왜 그렇게 짜였는지 보이지 않습니다. 이 개념은 아래 「롤링 배포: 한 번에 몇 대씩」 절의 풀 제외·헬스체크·풀 복귀 태스크와, 「흔한 실수와 점검표」 절의 "실패 시 영향 범위" 점검 항목에서 쓰입니다.

### 선언형과 명령형, 그리고 멱등성

명령형(imperative) 방식은 "무엇을 어떤 순서로 실행할지"를 적습니다. 셸 스크립트가 대표적입니다. 선언형(declarative) 방식은 "최종적으로 어떤 상태여야 하는지"를 적고 도달 방법은 도구에 맡깁니다. 내비게이션에 "좌회전, 직진 300m"를 하나씩 입력하는 것이 명령형이라면, 목적지만 입력하는 것이 선언형입니다. Ansible의 모듈 대부분은 선언형입니다. `ansible.builtin.package`에 `state: present`를 주면 "패키지가 설치된 상태"를 요구하는 것이고, 이미 설치되어 있으면 건드리지 않습니다. 다만 `command`나 `shell` 모듈은 임의의 명령을 그대로 실행하는 명령형이므로 멱등성을 직접 보장해야 합니다.

```bash
# 명령형: 두 번 실행하면 같은 줄이 두 번 들어간다(멱등하지 않음)
echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf
# 멱등하게 고친 셸 버전: 없을 때만 추가
grep -qx "net.ipv4.ip_forward=1" /etc/sysctl.conf || echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf
```

멱등성은 이런 "없을 때만 바꾼다"는 판단을 모든 작업에 일관되게 적용한 성질입니다. 수학의 절댓값처럼 `abs(abs(-3)) = abs(-3) = 3`, 한 번 적용한 결과에 다시 적용해도 값이 같습니다. 이 개념이 이 글의 중심인 이유는 Ansible 실행 결과의 `ok`와 `changed`, 정기 실행을 통한 드리프트 교정, 실패 후 재실행의 안전성이 모두 멱등성을 전제로 하기 때문입니다. 이 개념은 아래 「멱등성을 실행 결과로 이해하기」 절에서 첫 실행과 두 번째 실행의 차이로, 「멱등하지 않은 태스크와 고치는 법」 절에서 `creates`·`changed_when`으로, 「변경을 미리 보는 check 모드와 diff」 절에서 "바꾼다면 무엇이 바뀔지" 미리 계산하는 기반으로, 「운영에서 꼭 알아둘 기능」 절에서 롤 테스트의 재적용 검증으로 쓰입니다.

### 기존 방식과 비교

| 구분 | 수작업 SSH | 셸 스크립트 | Ansible |
|---|---|---|---|
| 방식 | 사람이 명령 입력 | 순서대로 명령 실행 | 원하는 상태 선언 |
| 반복 실행 | 사람이 판단 | 보통 위험(중복 추가 등) | 멱등 모듈이면 안전 |
| 변경 미리보기 | 불가능 | 직접 구현 | `--check`, `--diff` |
| 여러 서버 | 서버마다 반복 | 반복문 작성 | 인벤토리로 그룹 적용 |
| 기록 | 사람의 기억 | 스크립트 파일 | 코드 저장소와 이력 |
| 대상 서버 요구 | SSH | SSH와 셸 | SSH와 파이썬 |

표에서 보듯 Ansible이 모든 면에서 우월한 것은 아닙니다. 셸 스크립트는 의존성이 적고 단순한 작업에 빠르며, Ansible은 규모가 커질수록 이점이 커집니다.

### 기반 개념과 본문 연결 지도

아래 표는 위 개념들이 본문의 어느 절에서 어떤 역할로 다시 쓰이는지 한눈에 정리한 것입니다.

| 기반 개념 | 쓰이는 본문 절 | 그 절에서의 역할 |
|---|---|---|
| 패키지·서비스·권한 | 핵심 구성 요소 | `package`·`service` 모듈과 `become`, `mode`, `validate`의 의미 |
| 패키지·서비스·권한 | 핸들러: 변경이 있을 때만 한 번 실행 | 재시작이 아닌 재적재(reload)를 고르는 이유 |
| 패키지·서비스·권한 | 팩트 수집과 운영체제별 분기 | 배포판별 패키지 관리자와 패키지 이름 차이 |
| 패키지·서비스·권한 | 흔한 실수와 점검표 | 필요한 태스크에만 `become`을 거는 최소 권한 |
| SSH와 제어·관리 노드 | 인벤토리: 누구에게 적용할 것인가 | 접속 계정과 파이썬 경로 지정 |
| SSH와 제어·관리 노드 | 문법 검사와 린트 | `ping` 모듈로 SSH·파이썬 연결 점검 |
| SSH와 제어·관리 노드 | 롤링 배포: 한 번에 몇 대씩 | `delegate_to: localhost`로 제어 노드에서 실행 |
| YAML 문법 | 플레이북, 플레이, 태스크 | 플레이·태스크·핸들러의 들여쓰기 구조 |
| YAML 문법 | 변수와 우선순위 | `group_vars`·`host_vars` 변수 파일 |
| Jinja2 템플릿 | 변수, 템플릿, 핸들러 | `nginx.conf.j2`의 변수 치환과 반복문 |
| Jinja2 템플릿 | 비밀 정보 다루기 | `password_hash` 필터로 비밀번호 변환 |
| 코드 저장소와 CI | 롤: 재사용 가능한 묶음 | 저장소 단위로 공유·재사용하는 설정 묶음 |
| 코드 저장소와 CI | 운영에서 꼭 알아둘 기능 | 의존성 고정, 변경 이력, cron 정기 점검 |
| 코드 저장소와 CI | 구성 관리 도구 선택 기준 | 다른 IaC 도구와 역할 비교 |
| 로드밸런서와 헬스체크 | 업무 예시: 신규 웹 서버 표준화 | 롤링 배포의 풀 제외·확인·복귀 순서 |
| 선언형·명령형과 멱등성 | 멱등성을 실행 결과로 이해하기 | `ok`·`changed` 판정과 드리프트 감지 |
| 선언형·명령형과 멱등성 | 변경을 미리 보는 check 모드와 diff | 실제 변경 없이 차이를 계산하는 근거 |
| 선언형·명령형과 멱등성 | 용어 정리 | 멱등성·드리프트 용어의 정의 |

## 핵심 구성 요소

### 인벤토리: 누구에게 적용할 것인가

인벤토리(inventory)는 관리할 서버의 목록과 그룹을 적은 파일입니다. INI 형식이나 YAML 형식을 쓸 수 있습니다. 서버를 역할별 그룹으로 묶어 두면 "웹 서버에만 이 설정을 적용"처럼 대상을 좁힐 수 있고, 그룹 전체에 공통 변수를 붙일 수도 있습니다.

```ini
# inventory.ini
[web]
web01.example.internal
web02.example.internal

[db]
db01.example.internal ansible_user=deploy

[prod:children]
web
db

[prod:vars]
ansible_python_interpreter=/usr/bin/python3
```

`[prod:children]`은 web과 db 그룹을 prod 그룹의 하위로 묶는다는 뜻이고, `[prod:vars]`는 prod 전체에 변수를 적용합니다. 앞서 기반 기술에서 본 SSH 구조처럼 제어 노드는 이 호스트 이름으로 접속하고, `ansible_user`는 접속 계정, `ansible_python_interpreter`는 관리 노드에서 모듈을 실행할 파이썬 경로를 정합니다. 호스트 이름은 예시용 도메인이므로 실제 환경에 맞게 바꿔야 합니다. 서버 정보를 이렇게 파일로 적으면 인프라 구성이 코드 저장소에 남아 변경 이력을 추적할 수 있습니다. 클라우드 환경에서는 서버 목록이 수시로 바뀌므로 동적 인벤토리(dynamic inventory) 플러그인으로 목록을 자동 생성하기도 합니다.

### 모듈: 일을 하는 단위

모듈(module)은 "패키지 설치", "파일 복사", "서비스 재시작"처럼 한 가지 일을 하는 작은 프로그램입니다. 자주 쓰는 모듈은 다음과 같습니다. `ansible.builtin.package`는 앞서 기반 기술에서 본 apt·dnf 같은 패키지 관리자를 운영체제에 맞게 골라 설치·제거합니다. `ansible.builtin.template`은 앞서 기반 기술에서 본 Jinja2 템플릿(변수를 끼워 넣는 틀)으로 설정 파일을 만들어 배포합니다. `ansible.builtin.copy`는 파일을 그대로 복사합니다. `ansible.builtin.service`는 서비스의 시작·중지·활성화를 관리하고, `ansible.builtin.user`는 계정을 관리합니다. 모듈 이름 앞의 `ansible.builtin`은 Ansible 기본 컬렉션(collection, 모듈·플러그인 묶음)의 이름 공간입니다. 이렇게 완전한 이름(FQCN, Fully Qualified Collection Name)을 쓰면 다른 컬렉션의 같은 이름 모듈과 헷갈리지 않습니다.

### 플레이북, 플레이, 태스크

플레이북(playbook)은 "어떤 서버 그룹에, 어떤 작업들을, 어떤 순서로 적용할지" 적은 YAML 파일로, 앞서 기반 기술에서 본 목록(`- `)과 사전(`key: value`) 규칙대로 들여 씁니다. 플레이북 안에는 하나 이상의 플레이(play)가 있고, 플레이는 대상 호스트 그룹과 태스크(task) 목록으로 구성됩니다. 태스크 하나가 모듈 하나를 호출합니다. 아래는 웹 서버에 nginx를 설치하고 설정을 배포하는 최소 예시입니다.

```yaml
# site.yml
- name: 웹 서버 기본 설정
  hosts: web
  become: true
  vars:
    nginx_worker_connections: 1024
  tasks:
    - name: nginx 패키지 설치
      ansible.builtin.package:
        name: nginx
        state: present

    - name: nginx 설정 파일 배포
      ansible.builtin.template:
        src: nginx.conf.j2
        dest: /etc/nginx/nginx.conf
        owner: root
        group: root
        mode: "0644"
        validate: "nginx -t -c %s"
      notify: nginx 재적재

    - name: nginx 서비스 활성화와 시작
      ansible.builtin.service:
        name: nginx
        state: started
        enabled: true

  handlers:
    - name: nginx 재적재
      ansible.builtin.service:
        name: nginx
        state: reloaded
```

`become: true`는 권한 상승(sudo)으로 실행하라는 뜻입니다. `validate`는 설정 파일을 서버에 쓰기 전에 문법을 점검하는 옵션이라, 문법 오류가 있는 설정이 운영 서버에 배포되는 사고를 줄여 줍니다. 여기서 `%s`는 임시 파일 경로로 치환됩니다.

{% endraw %}<figure class="article-figure"><img src="{{ '/assets/images/ansible-idempotent-run-flow.svg' | relative_url }}" alt="인벤토리와 플레이북을 읽은 제어 노드가 SSH로 대상 서버의 현재 상태를 확인하고, 이미 원하는 상태면 ok, 다르면 changed로 바꾸며 핸들러를 한 번만 실행하는 흐름"><figcaption>그림. 제어 노드가 SSH로 관리 노드의 현재 상태를 조사하고, 다를 때만 수정하며 changed가 발생하면 핸들러를 실행한다. 이미지 출처: 직접 제작</figcaption></figure>{% raw %}

## 멱등성을 실행 결과로 이해하기

### 첫 실행과 두 번째 실행

앞서 기반 기술에서 본 선언형·멱등성 원리처럼, 플레이북을 처음 실행하면 서버가 원하는 상태와 다르므로 여러 태스크가 `changed`로 표시됩니다. 같은 플레이북을 곧바로 다시 실행하면 모든 태스크가 `ok`로 나와야 정상입니다. 다음은 학습용으로 구성한 출력 예시이며 실제 측정 결과가 아닙니다.

```text
$ ansible-playbook -i inventory.ini site.yml

PLAY [웹 서버 기본 설정] *********************************

TASK [nginx 패키지 설치] *********************************
changed: [web01.example.internal]
changed: [web02.example.internal]

TASK [nginx 설정 파일 배포] ******************************
changed: [web01.example.internal]
changed: [web02.example.internal]

TASK [nginx 서비스 활성화와 시작] *************************
ok: [web01.example.internal]
ok: [web02.example.internal]

RUNNING HANDLER [nginx 재적재] ***************************
changed: [web01.example.internal]
changed: [web02.example.internal]

PLAY RECAP ***********************************************
web01.example.internal : ok=5  changed=3  unreachable=0  failed=0
web02.example.internal : ok=5  changed=3  unreachable=0  failed=0
```

두 번째 실행에서는 패키지와 설정 파일이 이미 일치하므로 `changed=0`이 되고 핸들러도 실행되지 않습니다. PLAY RECAP의 숫자는 점검 지표로 쓸 수 있습니다. 운영 중인 서버에 정기 실행했는데 `changed`가 0이 아니라면 누군가 수작업으로 서버를 바꿨다는 신호, 즉 드리프트가 발견된 것입니다. 반대로 아무도 바꾸지 않았는데 매번 `changed`가 나온다면 그 태스크가 멱등하지 않다는 뜻이므로 고쳐야 합니다.

### 멱등하지 않은 태스크와 고치는 법

`command`나 `shell` 모듈은 가장 흔한 멱등성 위반의 원인입니다. 아래 예시는 매번 실행되는 나쁜 태스크와, 조건을 붙여 멱등하게 만든 태스크를 비교합니다.

```yaml
# 나쁜 예: 실행할 때마다 changed가 나오고 디렉터리를 다시 만들려 시도한다
- name: 애플리케이션 디렉터리 생성
  ansible.builtin.shell: mkdir /opt/app

# 나은 예: 전용 모듈이 선언형으로 상태를 맞춘다
- name: 애플리케이션 디렉터리 생성
  ansible.builtin.file:
    path: /opt/app
    state: directory
    mode: "0755"

# 전용 모듈이 없을 때: creates로 결과 파일이 있으면 건너뛴다
- name: 초기 데이터 적재 스크립트 실행
  ansible.builtin.command: /opt/app/bin/init-data.sh
  args:
    creates: /opt/app/.data-initialized
```

전용 모듈이 있으면 먼저 그것을 쓰는 것이 원칙입니다. 전용 모듈이 없어 `command`를 써야 한다면 `creates`(이 파일이 있으면 실행하지 않음)나 `removes`(이 파일이 없으면 실행하지 않음), 또는 `changed_when`으로 변경 판정 조건을 직접 지정합니다. 예를 들어 읽기만 하는 명령은 `changed_when: false`를 붙여 항상 `ok`로 보고하게 만듭니다.

```yaml
- name: 현재 nginx 버전 확인(읽기 전용)
  ansible.builtin.command: nginx -v
  register: nginx_version
  changed_when: false
```

## 변수, 템플릿, 핸들러

### 변수와 우선순위

같은 설정 파일이라도 운영 서버와 개발 서버는 값이 다릅니다. Ansible은 변수(variable)로 이 차이를 표현합니다. 변수는 인벤토리, `group_vars/그룹명.yml`, `host_vars/호스트명.yml`, 플레이북의 `vars`, 실행 때의 `-e` 옵션 등 여러 곳에서 정의할 수 있고, 같은 이름이 여러 곳에 있으면 정해진 우선순위에 따라 하나가 선택됩니다. 우선순위 표는 공식 문서에 있으며 대략 "범위가 좁고 명시적일수록 우선"입니다. `-e`로 주는 값이 가장 강해서, 급할 때 덮어쓰기는 편하지만 이력이 남지 않으므로 상시 사용은 피하는 편이 좋습니다. 입문 단계에서는 `group_vars`에 공통값, `host_vars`에 예외값을 두는 두 층 구조로 시작하는 것을 권합니다.

```text
project/
├── inventory.ini
├── site.yml
├── group_vars/
│   ├── all.yml          # 모든 서버 공통
│   └── web.yml          # web 그룹 전용
├── host_vars/
│   └── web02.example.internal.yml   # 이 서버만 예외
└── templates/
    └── nginx.conf.j2
```

### Jinja2 템플릿

템플릿 파일은 변수를 `{{ }}`로 끼워 넣고, 반복과 조건을 `{% %}`로 표현합니다. 다음은 앞 플레이북이 배포하는 `nginx.conf.j2`의 일부 예시입니다.

```jinja
# {{ ansible_managed }}
worker_processes auto;
events {
    worker_connections {{ nginx_worker_connections }};
}
http {
{% for upstream in app_upstreams %}
    # 업스트림: {{ upstream.name }}
{% endfor %}
    server_tokens off;
}
```

`ansible_managed`는 "이 파일은 Ansible이 관리하므로 직접 고치지 말라"는 안내 문구로 치환되는 특수 변수입니다. 이 한 줄이 있으면 누군가 서버에서 파일을 직접 편집하다 다음 실행 때 덮어쓰여 당황하는 일을 줄일 수 있습니다. 템플릿 결과가 이전과 같으면 `template` 모듈은 파일을 다시 쓰지 않으므로 멱등성이 유지됩니다.

### 핸들러: 변경이 있을 때만 한 번 실행

핸들러(handler)는 `notify`로 호출되는 특별한 태스크입니다. 설정 파일이 바뀌었을 때만 서비스를 재적재하고 싶을 때 씁니다. 중요한 성질은 두 가지입니다. 첫째, 호출한 태스크가 `changed`일 때만 실행됩니다. 둘째, 여러 태스크가 같은 핸들러를 호출해도 플레이 끝(또는 `meta: flush_handlers` 지점)에서 한 번만 실행됩니다. 덕분에 설정 파일 세 개를 바꿔도 서비스는 한 번만 재적재되어 불필요한 중단을 줄입니다. 주의할 점은 핸들러가 플레이 끝에 실행되므로 중간 태스크가 실패하면 핸들러가 실행되지 않은 채 설정만 바뀐 상태가 될 수 있다는 것입니다. 이 경우 다음 실행에서는 파일이 이미 일치해 `changed`가 아니므로 핸들러가 호출되지 않는 함정이 생길 수 있어, 중요한 서비스는 `--force-handlers` 옵션이나 명시적 재적재 확인을 검토해야 합니다.

## 변경을 미리 보는 check 모드와 diff

### --check와 --diff

`--check`(드라이런, dry run) 옵션은 실제로 서버를 바꾸지 않고 "바꾼다면 무엇이 바뀔지"를 보고합니다. `--diff`를 함께 주면 파일 내용의 변경 전후 차이를 보여 줍니다. 운영 서버에 적용하기 전 변경 검토 단계에 넣기 좋습니다.

```text
$ ansible-playbook -i inventory.ini site.yml --check --diff --limit web01.example.internal

TASK [nginx 설정 파일 배포] ******************************
--- before: /etc/nginx/nginx.conf
+++ after: /home/deploy/.ansible/tmp/.../nginx.conf.j2
@@ -2,3 +2,3 @@
 events {
-    worker_connections 768;
+    worker_connections 1024;
 }
changed: [web01.example.internal]
```

`--limit`은 인벤토리 전체가 아닌 특정 호스트에만 적용하게 합니다. 점진적 배포(카나리, canary)의 첫 단계로 서버 한 대에 먼저 적용하고 결과를 본 뒤 나머지로 넓히는 데 유용합니다. 단, check 모드는 한계가 있습니다. `command`나 `shell` 모듈은 기본적으로 check 모드에서 실행되지 않고 건너뛰므로, 그 결과에 의존하는 뒤쪽 태스크는 실제와 다르게 보고될 수 있습니다. 따라서 check 결과를 "완벽한 예측"이 아니라 "강력한 힌트"로 읽어야 합니다.

### 문법 검사와 린트

실행 전 점검 도구도 함께 씁니다. `ansible-playbook --syntax-check`는 YAML과 플레이북 구조의 오류를 잡고, ansible-lint라는 별도 도구는 모범 사례(FQCN 사용, 이름 없는 태스크, `shell` 남용 등)를 점검합니다. 이런 검사를 앞서 기반 기술에서 본 CI(Continuous Integration, 지속적 통합) 파이프라인에 넣으면 플레이북 변경이 병합되기 전에 기본적인 실수를 걸러 낼 수 있습니다.

```bash
# 문법 검사
ansible-playbook -i inventory.ini site.yml --syntax-check

# 적용 대상 호스트 확인
ansible-inventory -i inventory.ini --graph

# 연결 점검(핑 모듈, ICMP ping이 아니라 SSH와 파이썬 점검)
ansible -i inventory.ini web -m ansible.builtin.ping
```

## 업무 예시: 신규 웹 서버 표준화

### 시나리오

가상의 상황입니다. 팀이 웹 서버 두 대를 운영하는데, 한 대는 개발자가 급히 `worker_connections` 값을 직접 고쳐 두었고 다른 한 대는 방화벽 설정이 빠져 있습니다. 서버를 한 대 더 추가해야 하는데 "기존 서버와 똑같이"를 재현할 문서가 없습니다. 이 글은 가상의 사례이며 실제 운영 경험이 아닙니다.

### 도입 순서

첫째, 현재 상태를 코드로 옮깁니다. 가장 안정적인 서버의 설정 파일을 템플릿으로 가져오고, 서버별로 다른 값은 변수로 뺍니다. 둘째, 처음에는 `--check --diff`로만 실행해 코드와 실제 서버의 차이를 목록으로 만듭니다. 이 차이 목록이 바로 드리프트 보고서입니다. 셋째, 차이마다 "코드가 맞는가, 서버가 맞는가"를 사람이 판단해 코드를 고칩니다. 넷째, 한 대에 `--limit`으로 적용하고 서비스 확인 후 나머지 서버로 확산합니다. 다섯째, 두 번째 실행에서 `changed=0`이 되는지 확인해 멱등성을 점검합니다. 여섯째, 플레이북을 Git 저장소에 두고 변경은 검토를 거쳐 병합하게 합니다.

### 롤링 배포: 한 번에 몇 대씩

모든 서버를 동시에 바꾸면 설정 오류 하나가 전체 장애로 이어질 수 있습니다. 그래서 앞서 기반 기술에서 본 로드밸런서와 헬스체크처럼 한 대씩 풀에서 빼고, 바꾸고, 확인한 뒤 다시 넣습니다. `serial` 키워드는 한 번에 처리할 서버 수를 제한합니다. `max_fail_percentage`를 함께 쓰면 일정 비율 이상 실패했을 때 나머지 배포를 중단합니다.

```yaml
- name: 웹 서버 롤링 설정 적용
  hosts: web
  become: true
  serial: 1
  max_fail_percentage: 0
  pre_tasks:
    - name: 로드밸런서 풀에서 제외(예시 호출)
      ansible.builtin.uri:
        url: "https://lb.example.internal/api/pool/remove/{{ inventory_hostname }}"
        method: POST
      delegate_to: localhost
  roles:
    - webserver
  post_tasks:
    - name: 헬스체크 통과 확인
      ansible.builtin.uri:
        url: "http://{{ inventory_hostname }}/healthz"
        status_code: 200
      retries: 5
      delay: 3
      register: health
      until: health.status == 200
    - name: 로드밸런서 풀에 복귀(예시 호출)
      ansible.builtin.uri:
        url: "https://lb.example.internal/api/pool/add/{{ inventory_hostname }}"
        method: POST
      delegate_to: localhost
```

위 예시의 로드밸런서 주소와 API는 가상의 형태이며, 실제로는 사용하는 장비나 서비스의 API에 맞게 바꿔야 합니다. `delegate_to: localhost`는 이 태스크를 관리 노드가 아니라 제어 노드에서 실행하라는 지시입니다. `until`과 `retries`는 조건이 참이 될 때까지 재시도하는 반복 구조입니다.

## 롤: 재사용 가능한 묶음

### 롤의 구조

플레이북이 커지면 한 파일에 모든 것을 넣기 어렵습니다. 롤(role)은 태스크·변수·템플릿·핸들러를 정해진 디렉터리 구조로 묶어 재사용하는 단위입니다. `ansible-galaxy role init webserver` 명령으로 뼈대를 만들 수 있습니다.

```text
roles/webserver/
├── defaults/main.yml    # 기본 변수(가장 낮은 우선순위)
├── vars/main.yml        # 롤 내부 변수
├── tasks/main.yml       # 태스크 목록
├── handlers/main.yml    # 핸들러
├── templates/           # Jinja2 템플릿
├── files/               # 그대로 복사할 파일
└── meta/main.yml        # 의존성과 메타데이터
```

롤을 쓰면 "웹 서버 롤", "DB 클라이언트 롤", "모니터링 에이전트 롤"처럼 관심사를 나눌 수 있고, 플레이북은 어떤 서버에 어떤 롤을 붙일지만 적습니다. `defaults`는 사용자가 쉽게 덮어쓸 기본값을 두는 곳이므로, 롤을 설계할 때 바꿔도 되는 값은 `defaults`에, 바꾸면 안 되는 내부 값은 `vars`에 두는 구분이 도움이 됩니다.

## 비밀 정보 다루기

### Ansible Vault

데이터베이스 비밀번호나 API 키를 평문으로 저장소에 올리면 유출 사고로 이어집니다. Ansible Vault는 변수 파일이나 값 하나를 암호화해 저장소에 안전하게 둘 수 있게 해 주는 기능입니다. 실행 시 볼트 비밀번호를 입력하거나 비밀번호 파일을 지정해 복호화합니다.

```bash
# 비밀 변수 파일 암호화
ansible-vault encrypt group_vars/prod/vault.yml

# 암호화된 상태에서 편집
ansible-vault edit group_vars/prod/vault.yml

# 실행 시 볼트 비밀번호를 물어보게 함
ansible-playbook -i inventory.ini site.yml --ask-vault-pass
```

볼트는 "저장소에 올려도 안전한 저장 방식"을 제공할 뿐, 비밀번호 순환이나 접근 감사 같은 기능은 제공하지 않습니다. 규모가 커지면 외부 비밀 관리 서비스(예: 클라우드 사업자의 시크릿 매니저나 HashiCorp Vault)와 연동하는 방식을 검토합니다. 또한 태스크가 비밀 값을 로그에 출력하지 않도록 `no_log: true`를 지정해야 합니다. 실패 시 출력에 비밀번호가 찍히는 것은 흔한 실수입니다.

```yaml
- name: DB 계정 비밀번호 설정
  ansible.builtin.user:
    name: appdb
    password: "{{ vault_appdb_password | password_hash('sha512') }}"
  no_log: true
```

## 구성 관리 도구 선택 기준

### 도구별 성격

| 구분 | Ansible | Puppet·Chef류 | OpenTofu·Terraform류 |
|---|---|---|---|
| 주된 역할 | 서버 내부 설정, 배포 작업 | 서버 내부 설정 상태 유지 | 인프라 자원(서버·네트워크) 생성 |
| 에이전트 | 불필요(SSH) | 보통 필요 | 불필요(API 호출) |
| 실행 방식 | 필요할 때 밀어 넣기(push) | 주기적으로 가져가기(pull) | 계획 후 적용 |
| 상태 파일 | 없음(서버를 직접 조회) | 서버 측 카탈로그 | 상태 파일 필수 |
| 입문 난이도 | 비교적 낮음 | 비교적 높음 | 중간 |

표는 일반적인 경향이며 도구마다 예외가 있습니다. 이 블로그에서 다룬 OpenTofu와 역할이 다른 점이 중요합니다. OpenTofu는 가상 서버나 네트워크 같은 자원을 만들고 상태 파일로 추적하는 도구이고, Ansible은 만들어진 서버 안의 패키지·파일·서비스를 맞추는 도구입니다. 두 도구를 이어 쓰는 구성이 흔합니다. 즉 한쪽이 서버를 만들면 다른 쪽이 그 서버를 설정하는 순서입니다.

## 운영에서 꼭 알아둘 기능

### 태그와 limit으로 실행 범위 좁히기

플레이북이 커지면 "설정 파일만 다시 배포하고 싶다"는 요구가 생깁니다. 태스크에 `tags`를 붙이고 `--tags` 또는 `--skip-tags`로 실행 범위를 고르면 됩니다. 호스트 범위는 앞서 본 `--limit`이 맡습니다. 두 옵션을 조합하면 "web01에서 설정 배포 태스크만"처럼 정밀하게 실행할 수 있습니다. 다만 태그로 일부만 실행하는 습관이 굳으면 플레이북 전체를 돌렸을 때만 드러나는 순서 의존 문제를 놓칠 수 있습니다. 그래서 정기 점검은 태그 없이 전체를 `--check`로 돌리는 편이 안전합니다.

```bash
# 설정 배포 태스크만, web01에서만 미리 보기
ansible-playbook -i inventory.ini site.yml --tags config --limit web01.example.internal --check --diff

# 패키지 설치는 건너뛰기
ansible-playbook -i inventory.ini site.yml --skip-tags packages
```

### 컬렉션과 의존성 고정

Ansible의 모듈은 컬렉션 단위로 배포됩니다. 외부 컬렉션(예: 클라우드나 데이터베이스용)을 쓰면 버전이 바뀌면서 모듈 동작이 달라질 수 있습니다. 그래서 `requirements.yml`에 컬렉션과 버전 범위를 적어 저장소에 두고 `ansible-galaxy collection install -r requirements.yml`로 설치하면, 팀원과 CI가 같은 의존성으로 실행하게 됩니다. 제어 노드의 Ansible 버전과 파이썬 버전도 문서에 기록해 두는 것이 좋습니다. 같은 플레이북이 사람마다 다르게 동작하는 원인의 상당수가 이런 환경 차이입니다.

```yaml
# requirements.yml
collections:
  - name: ansible.posix
    version: ">=1.5.0"
  - name: community.general
    version: ">=8.0.0"
```

### 롤 단위 테스트

롤이 늘어나면 변경이 다른 서버에 미치는 영향을 사람이 눈으로 확인하기 어렵습니다. 컨테이너나 임시 가상 머신에서 롤을 적용한 뒤 "두 번째 실행에서 changed가 없는지(멱등성)"와 "서비스가 실제로 응답하는지"를 검증하는 테스트 도구를 CI에 붙이는 방식이 널리 쓰입니다. 대표적으로 Molecule 같은 프레임워크가 있으며, 이 글에서는 사용법을 직접 다루지 않습니다. 핵심은 도구가 무엇이든 "적용 → 재적용 → 검증"의 세 단계를 자동화하는 것입니다. 이렇게 하면 앞서 말한 멱등성 위반이 병합 전에 잡힙니다.

### 변경 관리와 이력

서버 변경은 보통 변경 승인 절차와 연결됩니다. Ansible 플레이북을 Git에 두면 "누가, 언제, 왜 바꿨는가"가 커밋 이력과 병합 요청(Pull Request)에 남습니다. 여기에 `--check --diff` 출력 결과를 변경 요청서에 첨부하면 승인자가 변경될 내용을 구체적으로 볼 수 있습니다. 또한 실행 로그를 중앙에 보관하면 사고 후 "그때 어떤 변경이 적용되었는가"를 추적할 수 있습니다. 감사 대응이 필요한 조직에서는 이런 기록이 수작업 서버 관리보다 훨씬 설명하기 쉽습니다. 단 이 글은 특정 감사 기준의 충족 여부를 보장하지 않으며, 실제 기준은 조직의 정책과 감사인의 요구에 따라야 합니다.

### 팩트 수집과 운영체제별 분기

Ansible은 플레이 시작 때 관리 노드의 운영체제 종류, 버전, 네트워크 정보 같은 사실(fact)을 자동으로 모읍니다. 이 값은 `ansible_facts`라는 변수로 쓸 수 있어서 "데비안 계열이면 apt, 레드햇 계열이면 dnf"처럼 분기하는 조건에 활용됩니다. `package` 모듈은 이런 분기를 대신해 주지만, 패키지 이름 자체가 배포판마다 다른 경우(예: 웹 서버 패키지 이름)에는 `when: ansible_facts['os_family'] == 'Debian'` 같은 조건으로 변수를 나눠야 합니다. 팩트 수집은 서버가 많으면 시간이 걸리므로, 팩트가 필요 없는 플레이에서는 `gather_facts: false`로 끄는 최적화도 흔합니다. 다만 끄면 팩트에 의존하는 조건식이 실패하므로 의존 여부를 확인한 뒤에 적용해야 합니다.

```yaml
- name: 운영체제 계열에 따라 웹 서버 패키지 선택
  ansible.builtin.package:
    name: "{{ 'apache2' if ansible_facts['os_family'] == 'Debian' else 'httpd' }}"
    state: present
```

### 실행 이력의 활용과 정기 점검 예시

플레이북을 정기적으로 `--check` 모드로 돌리면 "드리프트 감시기"로 쓸 수 있습니다. 스케줄러(cron 등)로 하루 한 번 실행하고, 출력의 PLAY RECAP에서 `changed`가 0보다 큰 호스트가 있으면 담당자에게 알리는 단순한 구성입니다. 이때 알림이 너무 자주 오면 사람들이 무시하게 되므로, 처음에는 주 1회로 시작해 허용할 수 있는 예외(예: 의도된 임시 변경)를 코드에 반영해 가며 소음을 줄입니다. 아래는 개념을 보이기 위한 셸 예시이며 실제 환경의 경로와 알림 수단은 바꿔야 합니다.

```bash
#!/usr/bin/env bash
# 개념 예시: 드리프트 점검 후 changed 호스트가 있으면 알림
set -euo pipefail
OUT=$(ansible-playbook -i inventory.ini site.yml --check 2>&1 || true)
echo "$OUT" | grep -E "changed=[1-9]" && echo "드리프트 감지: 점검 필요" || echo "드리프트 없음"
```

이 점검은 완전하지 않습니다. check 모드가 건너뛰는 `command` 계열 태스크의 드리프트는 보이지 않기 때문입니다. 그래도 "수작업으로 바뀐 설정 파일과 꺼진 서비스"처럼 흔한 드리프트를 조기에 발견하는 데는 충분히 유용합니다.

## 용어 정리

| 용어 | 쉬운 설명 |
|---|---|
| 제어 노드 | Ansible을 실행하는 컴퓨터 |
| 관리 노드 | 설정을 받는 서버 |
| 인벤토리 | 서버 목록과 그룹 |
| 모듈 | 패키지 설치 같은 단일 작업을 하는 프로그램 |
| 태스크 | 모듈 하나를 호출하는 작업 단위 |
| 플레이북 | 대상과 태스크를 적은 YAML 파일 |
| 롤 | 재사용 가능한 설정 묶음 |
| 핸들러 | 변경이 있을 때만 실행되는 태스크 |
| 멱등성 | 반복해도 결과가 같은 성질 |
| 드리프트 | 코드와 실제 서버 사이의 차이 |

용어를 정확히 구분하면 문서와 로그를 읽기가 훨씬 쉬워집니다. 특히 "태스크는 모듈을 호출하는 단위, 플레이는 호스트 그룹과 태스크의 묶음"이라는 관계를 기억해 두면 오류 메시지의 위치를 파악하기 쉽습니다.

## 한계와 적용 기준 Q&A

### Q. Ansible 하나로 서버 상태를 항상 정확히 유지할 수 있나요?

A. 아닙니다. Ansible은 실행되는 순간에만 상태를 맞춥니다. 실행과 실행 사이에 누군가 서버를 직접 바꾸면 다음 실행 전까지 드리프트가 존재합니다. 지속적으로 상태를 강제하려면 정기 실행(예: 스케줄러로 하루 한 번 `--check`를 돌려 `changed`가 있으면 알림)을 구성하거나, 서버 변경 권한 자체를 통제하는 운영 규칙을 함께 세워야 합니다.

### Q. 서버 수가 매우 많아지면 성능이 문제 되지 않나요?

A. SSH 연결을 서버마다 만들기 때문에 대규모에서는 시간이 오래 걸릴 수 있습니다. `forks`(동시에 처리할 서버 수) 설정, SSH 연결 재사용(ControlPersist), 파이프라이닝 같은 튜닝이 있지만 수천 대 이상에서는 별도 실행 플랫폼이나 pull 방식 도구가 더 적합할 수 있습니다. 구체적인 한계 수치는 환경마다 달라서 이 글에서 단정할 수 없고, 자기 환경에서 측정해야 합니다.

### Q. command나 shell을 쓰면 안 되나요?

A. 쓸 수는 있지만 마지막 수단입니다. 전용 모듈은 상태를 검사하고 변경 여부를 정확히 보고하며 check 모드도 지원합니다. `shell`은 이런 장점이 모두 없고 셸 인젝션(shell injection, 변수 값에 섞인 특수문자가 의도치 않은 명령으로 실행되는 취약점) 위험도 있습니다. 불가피하게 쓴다면 `creates`·`changed_when`·`failed_when`으로 멱등성과 실패 판정을 직접 정의하고, 변수는 `quote` 필터로 감쌉니다.

### Q. 플레이북을 실행하다 중간에 실패하면 어떻게 되나요?

A. 실패한 호스트는 해당 플레이에서 이후 태스크가 중단되고 다른 호스트는 계속 진행됩니다. 멱등하게 작성했다면 원인을 고친 뒤 같은 플레이북을 다시 실행하면 이미 끝난 부분은 `ok`로 지나가고 실패했던 지점부터 의미 있게 이어집니다. `block`, `rescue`, `always` 구조로 실패 시 정리 작업을 정의할 수도 있습니다. 다만 이미 일부 변경된 상태에서의 부분 적용이 서비스에 영향을 줄 수 있으므로 `serial`과 헬스체크로 위험을 줄이는 설계가 중요합니다.

### Q. 처음 도입할 때 무엇부터 해야 하나요?

A. 위험이 낮고 효과가 눈에 보이는 일부터 시작합니다. 예를 들어 "모든 서버의 시간 동기화 설정 확인"이나 "필수 패키지 설치 여부 점검"처럼 읽기 위주의 `--check` 작업으로 시작해 신뢰를 쌓은 뒤 변경 작업으로 넓힙니다. 처음부터 운영 전체를 코드로 옮기려 하면 범위가 커져 중도에 멈추기 쉽습니다.

## 흔한 실수와 점검표

### 자주 겪는 실수

첫째, 태스크 이름(`name`)을 생략하는 것입니다. 이름이 없으면 실행 로그에서 어떤 작업인지 알기 어렵습니다. 둘째, `shell`로 해결하고 `changed_when`을 지정하지 않아 정기 실행 때 항상 `changed`가 나와 진짜 드리프트 신호가 묻히는 것입니다. 셋째, 비밀 값을 `group_vars`에 평문으로 두는 것입니다. 넷째, `become` 없이 실행해 권한 오류가 나고, 급한 마음에 모든 태스크에 루트 권한을 주는 것입니다. 필요한 태스크에만 `become`을 거는 편이 최소 권한 원칙에 맞습니다. 다섯째, 서버에서 직접 설정을 고치고 코드에 반영하지 않아 다음 실행이 변경을 되돌리는 것입니다. 마지막으로, 인벤토리와 변수에 서버 정보를 하드코딩해 환경별 차이를 관리하지 못하는 것입니다.

### 적용 전 점검표

| 점검 항목 | 확인 방법 |
|---|---|
| 문법 오류 없음 | `ansible-playbook --syntax-check` |
| 모범 사례 위반 없음 | ansible-lint 실행 |
| 변경 예상 확인 | `--check --diff --limit 한 대` |
| 두 번째 실행 `changed=0` | 같은 명령 재실행 후 PLAY RECAP 확인 |
| 비밀 값 보호 | 볼트 암호화와 `no_log: true` |
| 실패 시 영향 범위 | `serial`, `max_fail_percentage`, 헬스체크 |
| 되돌리기 계획 | 이전 설정 보관, 코드 저장소 이력 |

이 점검표는 변경 관리 문서의 체크리스트로 옮겨 쓸 수 있습니다. 모든 항목을 매번 자동화하기는 어렵지만, 최소한 문법 검사와 `--check`는 변경 요청 단계에서 자동으로 돌도록 만드는 것이 좋습니다.

## 마무리

Ansible의 핵심은 "명령을 실행한다"가 아니라 "원하는 상태를 선언하고, 이미 맞으면 건드리지 않는다"는 멱등성에 있습니다. 인벤토리로 대상을 정하고, 플레이북과 롤로 상태를 선언하며, 핸들러로 변경이 있을 때만 서비스를 재적재하고, `--check --diff`로 변경을 미리 확인하는 흐름을 익히면 수작업 서버 관리에서 오는 드리프트와 실수를 크게 줄일 수 있습니다. 동시에 한계도 분명합니다. 실행 시점에만 상태를 맞추고, `shell` 남용은 멱등성을 깨며, 대규모에서는 별도 설계가 필요합니다.

처음 시작한다면 서버 한두 대와 읽기 위주의 `--check`로 출발해 보세요. 두 번째 실행에서 `changed=0`이 나오는지 확인하는 것만으로도 멱등성 감각이 빠르게 생깁니다. 그 뒤 변경 작업, 롤, 볼트, 롤링 배포 순으로 넓혀 가면 무리 없이 운영 자동화로 이어집니다.

<h3 class="references-heading">참고 자료</h3>

- [Ansible Documentation: Ansible concepts and introduction](https://docs.ansible.com/ansible/latest/getting_started/introduction.html)
- [Ansible Documentation: Validating tasks: check mode and diff mode](https://docs.ansible.com/ansible/latest/playbook_guide/playbooks_checkmode.html)
- [Ansible Documentation: Handlers: running operations on change](https://docs.ansible.com/ansible/latest/playbook_guide/playbooks_handlers.html)
- [Ansible Documentation: How to build your inventory](https://docs.ansible.com/ansible/latest/inventory_guide/intro_inventory.html)
- [Ansible Documentation: Tips and tricks](https://docs.ansible.com/ansible/latest/tips_tricks/ansible_tips_tricks.html)
- [Ansible Documentation: Protecting sensitive data with Ansible vault](https://docs.ansible.com/ansible/latest/vault_guide/index.html)
- [Ansible Documentation: Error handling in playbooks](https://docs.ansible.com/ansible/latest/playbook_guide/playbooks_error_handling.html)
{% endraw %}
