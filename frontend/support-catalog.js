(() => {
  'use strict';

  const MAP_REGIONS = [
    {
      id: 'norte',
      title: 'Lojas do Norte',
      states: 'AC - AM - AP - PA - RO - RR - TO',
      url: 'https://www.google.com/maps/d/u/0/edit?mid=1dn53HpediSihL7-am8NMVRg_o_PLAu4&usp=sharing',
    },
    {
      id: 'nordeste',
      title: 'Lojas do Nordeste',
      states: 'AL - BA - CE - MA - PB - PE - PI - RN',
      url: 'https://www.google.com/maps/d/u/0/viewer?mid=19aUDdiyUwuvMNPQ1uwpT8Jw-F70ZezY&ll=-10.102174947744842%2C-41.16191960000002&z=5',
    },
    {
      id: 'centro-oeste',
      title: 'Lojas do Centro-Oeste',
      states: 'DF - GO - MS - MT',
      url: 'https://www.google.com/maps/d/u/0/viewer?mid=1runCan1qeidGojzbXytuAI-uhEkjXis&ll=-18.940603342332015%2C-51.98935009999999&z=7',
    },
    {
      id: 'sudeste',
      title: 'Lojas do Sudeste',
      states: 'ES - MG - RJ',
      url: 'https://www.google.com/maps/d/u/0/viewer?mid=1rsMONiA78L5W_vkgUyhbhiieT6heQZg&ll=-21.64142220737699%2C-44.64952075&z=6',
    },
    {
      id: 'sul',
      title: 'Lojas do Sul',
      states: 'PR - RS - SC',
      url: 'https://www.google.com/maps/d/u/0/viewer?mid=1UfKJWaf9y7DyNewYcAwM86VKAY9JCrk&ll=-27.619521919757208%2C-51.49806214999999&z=6',
    },
    {
      id: 'sao-paulo',
      title: 'Lojas de São Paulo',
      states: 'SP',
      url: 'https://www.google.com/maps/d/u/0/viewer?mid=1NFr8lx6xylk9vMdCknWNMeDp3Po4ql0&ll=-22.577052395234443%2C-48.41055760000001&z=7',
    },
  ];

  const BASE_CATEGORIES = [
    {
      id: 'maquineta',
      group: 'equipamentos',
      title: 'Maquineta de cartão',
      icon: '/fac/img/Icons/Maquineta.svg',
      summary: 'Pagamento em cartão offline e substituição da maquineta.',
      procedures: [
        {
          id: 'offline-microtef',
          title: 'Pagamento em cartão temporariamente indisponível',
          keywords: ['maquineta', 'offline', 'microtef', 'cartão', 'pinpad', 'totem'],
          body: '<h4>Maquineta de cartão offline</h4><p>Para resolver, siga os passos abaixo:</p><ol><li>Acesse a loja (Totem) usando o Chrome Remote e pressione as teclas do Windows + R.</li><li>Digite <strong>cmd</strong> e pressione Ctrl + Shift + Enter para abrir o terminal como administrador.</li><li>No terminal, digite o comando <strong>microtef stop</strong> e pressione Enter.</li><li>Ainda no terminal, digite o comando <strong>microtef start</strong> e pressione Enter.</li><li>Reinicie o totem para que o sistema sincronize com os serviços da maquineta.</li></ol><h4>Se o procedimento anterior não funcionar</h4><ol><li>Acesse a loja (totem) através do Chrome Remote e clique com o botão direito do mouse sobre o ícone do Windows na barra de tarefas.</li><li>Selecione a opção Gerenciador de dispositivos e expanda a categoria Portas (COM e LPT).</li><li>Anote o número da porta COM que corresponde à maquineta, por exemplo COM5.</li><li>Abra o explorador de arquivos e navegue até a pasta Lavanderia60minutos no disco local (C).</li><li>Abra o arquivo <strong>conf.ini</strong> com um editor de texto e localize a linha <strong>pinpadport=COM4</strong>.</li><li>Altere o número da porta COM para o que você anotou e salve o arquivo.</li><li>Abra o prompt de comando e digite <strong>Microtef restart</strong> para reiniciar o serviço da maquineta.</li><li>Reinicie o totem para garantir a sincronização da maquineta com o totem.</li></ol>',
        },
        {
          id: 'substituicao-conf-ini',
          title: 'Substituição da Maquineta de Cartão',
          keywords: ['maquineta', 'substituição', 'conf.ini', 'COM', 'pinpadport', 'microtef'],
          body: '<h4>Substituição/Configuração da maquineta de cartão</h4><ol><li>Peça para o franqueado conectar a maquineta normalmente no totem usando o cabo USB.</li><li>Acesse a loja (totem) através do Chrome Remote e clique com o botão direito do mouse sobre o ícone do Windows na barra de tarefas.</li><li>Selecione a opção Gerenciador de dispositivos e expanda a categoria Portas (COM e LPT).</li><li>Anote o número da porta COM que corresponde à maquineta, por exemplo COM5.</li><li>Abra o explorador de arquivos e navegue até a pasta Lavanderia60minutos no disco local (C).</li><li>Abra o arquivo <strong>conf.ini</strong> com um editor de texto e localize a linha <strong>pinpadport=COM4</strong>.</li><li>Altere o número da porta COM para o que você anotou no passo 4 e salve o arquivo.</li><li>Abra o prompt de comando e digite <strong>Microtef restart</strong> para reiniciar o serviço da maquineta.</li><li>Reinicie o totem para garantir a sincronização da maquineta com o totem.</li></ol>',
        },
      ],
    },
    {
      id: 'lavadoras',
      group: 'equipamentos',
      title: 'Lavadoras/Secadoras',
      icon: '/fac/img/Icons/Lavadora.svg',
      summary: 'Tempo restante, máquinas offline, ping de IPs e códigos de erro.',
      procedures: [
        {
          id: 'tempo-restante',
          title: 'Máquina liberada em tempo restante',
          keywords: ['lavadora', 'secadora', 'tempo restante', 'liberação', 'CPF'],
          body: '<h4>Máquina liberada em tempo restante</h4><ol><li>Primeiramente, solicite ao cliente o seu CPF ou endereço de e-mail para localizar o respectivo cadastro.</li><li>Em seguida, pergunte ao cliente qual o código da máquina que ele utilizou. Verifique no sistema se a máquina de fato foi liberada em tempo restante.</li><li>Se sim, realize uma nova liberação ao cliente e, em sequência, registre uma ocorrência em seu cadastro.</li></ol>',
        },
        {
          id: 'maquinas-offline',
          title: 'Máquinas offline',
          keywords: ['lavadora', 'offline', 'ping', 'rede', 'FN2014', 'winbox'],
          body: '<h4>Verificar status das máquinas na loja</h4><ol><li>Acesse a loja e pressione as teclas Windows + R para abrir o prompt de comando.</li><li>Escreva <strong>cmd</strong> e pressione Enter.</li><li>Digite <strong>ping</strong> seguido do endereço IP da lavadora que você quer testar. Por exemplo, <strong>ping 192.168.50.101</strong> para testar a lavadora 432.</li><li>Observe a resposta do comando. Se aparecer uma mensagem como "Resposta de 192.168.50.101: bytes=32 tempo=5ms TTL=255", significa que a lavadora está online e funcionando normalmente. Se aparecer "host de destino inacessível", significa que a lavadora está offline ou com algum problema de conexão.</li></ol><h4>Ping das máquinas e dispositivos em loja</h4><ul><li>GET: <strong>ping 192.168.50.100</strong></li><li>Lavadora 432: <strong>ping 192.168.50.101</strong></li><li>Lavadora 543: <strong>ping 192.168.50.102</strong></li><li>Lavadora 654: <strong>ping 192.168.50.103</strong></li><li>Secadora 765: <strong>ping 192.168.50.104</strong></li><li>Secadora 876: <strong>ping 192.168.50.105</strong></li><li>Secadora 987: <strong>ping 192.168.50.106</strong></li><li>RESET: <strong>ping 192.168.50.107</strong></li><li>Noteiro NT: <strong>ping 192.168.50.108</strong></li><li>Noteiro NTR: <strong>ping 192.168.50.109</strong></li><li>Sensor do Ar-condicionado: <strong>ping 192.168.50.110</strong></li></ul><h4>Se a máquina estiver fora da rede ou offline</h4><p><strong>Acesse o sistema Web e verifique o status da máquina:</strong></p><ul><li>Verifique se a máquina está suspensa ou ativa no sistema Web.</li><li>Se estiver suspensa, ative-a no sistema.</li></ul><p><strong>Verifique a conexão de rede na loja:</strong></p><ul><li>Acesse a loja e verifique se o notebook está conectado à rede FN2014.</li><li>Se não estiver conectado, faça a conexão à rede.</li><li>Verifique se a máquina ficou online após a conexão.</li></ul><p><strong>Verifique a hora do notebook:</strong></p><ul><li>Verifique se a hora do notebook está correta.</li><li>Se não estiver correta, faça a alteração da data e hora do notebook.</li></ul><p><strong>Reinicie o Winbox64:</strong></p><ul><li>Acesse o Winbox64 e faça login.</li><li>Vá para a opção "System".</li><li>Selecione "Reboot" e confirme clicando em "Yes".</li><li>Assim que o Winbox64 reiniciar, verifique se a máquina ficou online.</li></ul><p><strong>Entre em contato com o franqueado:</strong></p><ul><li>Se a máquina ainda não estiver online, entre em contato com o franqueado.</li><li>Peça ao franqueado para desligar a máquina da tomada ou fonte de energia.</li><li>Aguarde aproximadamente 3 minutos.</li><li>Peça ao franqueado para ligar a máquina novamente.</li><li>Verifique se a máquina voltou a ficar online.</li></ul>',
        },
        {
          id: 'codigos-erro',
          title: 'Códigos de erro (DE1, OE, UE, FE, LE, IE)',
          keywords: ['erro', 'DE1', 'OE', 'UE', 'FE', 'LE', 'IE', 'código', 'lavadora'],
          body: '<h4>Resumo dos códigos de erro mais comuns</h4><h4>DE1 — Erro de porta 1</h4><p>Indica que a porta não está bem fechada. Pode ocorrer se houver peças de roupa presas na porta ou se ela não for pressionada com força suficiente.</p><p><strong>Solução:</strong> oriente o cliente a retirar as peças de roupa da porta da lavadora e a fechar com um pouco mais de pressão.</p><h4>IE — Falha no abastecimento de água</h4><p>Se a lavadora não encher de água em até 8 minutos após iniciar o processo, o código <strong>IE</strong> será exibido. Indica problema no fornecimento de água.</p><p><strong>Solução:</strong> peça ao franqueado verificar torneiras, válvulas, mangueiras de abastecimento, filtro e pressão da água (entre 100kPa e 1000kPa).</p><h4>OE — Problemas na drenagem</h4><p>Se a drenagem não iniciar em até 10 minutos, o painel pode mostrar <strong>OE</strong>. Significa que a mangueira de drenagem está obstruída, bloqueada, torcida ou dobrada.</p><p><strong>Solução:</strong> solicite ao franqueado verificar se a mangueira de drenagem está livre de obstruções, bloqueios, torções ou dobras.</p><h4>UE — Desequilíbrio no tambor</h4><p>Indica desequilíbrio no tambor, impedindo o giro adequado. Cargas acima da capacidade do cesto podem causar este erro.</p><p><strong>Solução:</strong> peça ao cliente distribuir as roupas no tambor respeitando a capacidade do cesto. Se persistir, remover algumas roupas.</p><h4>FE — Problemas na válvula</h4><p>Indica excesso de água devido a falha na válvula de entrada.</p><p><strong>Solução:</strong> verificar nível e pressão da água (14 a 84 MAC), fechar torneira e desconectar da tomada, realizar reset (segurar Início/Pausa por 10 segundos com a lavadora desligada) e testar novo ciclo.</p><h4>LE — Sobrecarga no motor</h4><p>Indica falha de comunicação entre a placa de controle e o motor ou sobrecarga.</p><p><strong>Solução:</strong> verificar excesso de roupas, girar o tambor lentamente, retirar peças se necessário, realizar reset. Se persistir após 30 minutos de espera, contatar o departamento Técnico.</p>',
        },
      ],
    },
    {
      id: 'noteiro',
      group: 'equipamentos',
      title: 'Noteiro',
      icon: '/fac/img/Icons/Noteiro.svg',
      summary: 'Problemas de contabilização de cédulas no noteiro.',
      procedures: [
        {
          id: 'nao-contabilizou',
          title: 'Noteiro não contabilizou corretamente',
          keywords: ['noteiro', 'dinheiro', 'cédula', 'saldo', 'contabilizou'],
          body: '<h4>Noteiro não contabilizou corretamente</h4><ol><li>Solicite ao cliente o seu CPF/E-mail para identificação e localização do cadastro. Em seguida, proceda à verificação nas câmeras para confirmar se o cliente inseriu o valor corretamente.</li><li>Caso o cliente tenha inserido o valor corretamente, tire um print do momento da inserção e informe no grupo do WhatsApp. Realize o ajuste no saldo do cliente e registre uma ocorrência em seu cadastro.</li><li>Se for constatado que o cliente não inseriu as cédulas, informe que não foi possível verificar a inserção nas imagens das câmeras e não realize nenhum ajuste de saldo em seu cadastro.</li><li>Caso o cliente questione, solicite que envie um e-mail para <strong>atendimento@lavanderia60minutos.com.br</strong>.</li></ol>',
        },
      ],
    },
    {
      id: 'modem',
      group: 'equipamentos',
      title: 'Modem/MikroTik',
      icon: '/fac/img/Icons/Modem.svg',
      summary: 'Configuração e atualização do MikroTik via Winbox.',
      procedures: [
        {
          id: 'mikrotik-reset-mk60m',
          title: 'Como configurar/Atualizar o MikroTik',
          keywords: ['modem', 'mikrotik', 'winbox', 'MK 60M', 'reset', 'roteador'],
          body: '<h4>Para configurar/Atualizar o MikroTik siga os passos abaixo</h4><ol><li>O cabo de rede está conectado uma extremidade no notebook e a outra no MikroTik; peça para o franqueado conectar a extremidade que está no MikroTik no modem da operadora.</li><li>Acesse o totem e abra o <strong>Winbox</strong>.</li><li>Vá em <strong>System</strong> e clique em <strong>Reset Configuration</strong> e aguarde o Winbox reiniciar.</li><li>Assim que ele reiniciar, o IP Address estará zerado; então você acessa o MAC Address.</li><li>Em seguida, vá em <strong>Files</strong> e exclua todos os arquivos.</li><li>Depois faça o upload do arquivo zipado <strong>MK 60M.zip</strong> e em seguida extraia o arquivo no totem.</li><li>Em seguida, copie para a pasta <strong>Files</strong>.</li><li>Após copiar para a pasta Files, vá em <strong>New Terminal</strong> e importe o arquivo <strong>60M.rsc</strong>.</li><li>Após importar o arquivo volte para <strong>System</strong> e clique em <strong>Reboot</strong>.</li><li>Pronto, MikroTik configurado/atualizado. Peça para o franqueado voltar o cabo de rede.</li></ol>',
        },
      ],
    },
    {
      id: 'totem',
      group: 'equipamentos',
      title: 'Totem',
      icon: '/fac/img/Icons/Computador.svg',
      summary: 'Ativação de loja e configuração do notebook.',
      procedures: [
        {
          id: 'ativacao-loja',
          title: 'Ativação de loja/Configuração do notebook',
          keywords: ['totem', 'ativação', 'loja', 'chrome remote', 'banco de dados', 'sincronização'],
          body: '<h4>Sequência de ativação da loja</h4><p>É essencial seguir rigorosamente a sequência dos procedimentos abaixo para garantir uma configuração livre de falhas:</p><ol><li><strong>Google Chrome Remote</strong></li><li><strong>Banco de dados</strong></li><li><strong>Sincronização</strong></li><li><strong>Televisão</strong></li><li><strong>Roteador (MikroTik)</strong></li><li><strong>GET</strong></li><li><strong>PING</strong></li><li><strong>RESET</strong></li><li><strong>Ar-condicionado</strong></li><li><strong>Crédito em cartão</strong></li><li><strong>Crédito em dinheiro</strong></li><li><strong>Máquinas em rede</strong></li><li><strong>Câmeras</strong></li><li><strong>Área restrita</strong></li><li><strong>Ajustar as câmeras</strong></li></ol><h4>Google Chrome Remote</h4><ol><li>Acesse a loja utilizando o Software de acesso remoto <strong>AnyDesk</strong>.</li><li>No computador da loja, abra o navegador Google Chrome e digite <strong>https://remotedesktop.google.com/</strong> na barra de endereço.</li><li>Clique em Acessar o meu computador e, na seção Configurar acesso remoto, baixe o programa de acesso remoto do Google Chrome.</li><li>Após o download, execute o arquivo e siga as instruções para instalar.</li><li>Defina o nome da loja e a senha (dois últimos números da loja + 2010; exemplo PB05 → senha 052010).</li></ol><h4>Banco de dados</h4><ol><li>Abra o Valentina Studio 10 digitando seu nome na barra de pesquisa do Windows.</li><li>Conecte-se ao servidor local "PostgreSQL" ou "localhost:5432" com a senha.</li><li>Exclua o banco de dados antigo "laundry60_totem" e crie um novo com o mesmo nome.</li><li>Clique com o botão direito no novo banco de dados e escolha "Load Dump".</li><li>Selecione o arquivo atualizado do banco de dados no HD externo e clique em "Next".</li><li>Carregue o arquivo no banco de dados e clique em "OK" para finalizar.</li></ol><h4>Sincronização</h4><ol><li>Abra o aplicativo <strong>Sistema60minutes.exe</strong> na área de trabalho e mantenha-o aberto por alguns minutos para sincronização automática.</li><li>Verifique na barra de tarefas (ícone de seta para cima) se os ícones dos sistemas estão sincronizados. Aguarde até a conclusão.</li></ol><h4>Roteador (MikroTik)</h4><p>Reset Configuration no Winbox, upload do <strong>MK 60M.zip</strong>, importação do <strong>60M.rsc</strong> e Reboot.</p><h4>GET / RESET / Ar-condicionado</h4><p>Conectar plaquinha via USB, enviar firmware e programa <strong>ESP8266Flasher</strong>, selecionar arquivo na aba Config e clicar Flash(F) na aba Operation.</p><h4>Crédito em cartão</h4><p>Configurar porta COM no <strong>conf.ini</strong> (pinpadport), inserir STONECODE do sistema Web, executar <strong>Microtef restart</strong> e reiniciar o totem.</p>',
        },
      ],
    },
    {
      id: 'ar-condicionado',
      group: 'equipamentos',
      title: 'Ar-condicionado',
      icon: '/fac/img/Icons/Ar-condicionado.svg',
      summary: 'Ar não liga ao inserir CPF e configuração do sensor ESP8266.',
      procedures: [
        {
          id: 'nao-liga-cpf',
          title: 'Ar-condicionado não liga ao inserir o CPF',
          keywords: ['ar-condicionado', 'CPF', 'sensor', 'ping', '192.168.50.110'],
          body: '<h4>Ar-condicionado não liga ao inserir o CPF</h4><ol><li>Acesse a loja pelo Google Chrome Remote e abra o prompt de comando com <strong>cmd</strong>.</li><li>Digite <strong>ping 192.168.50.110</strong> para verificar se o sensor do ar-condicionado está online. Se online, será necessário realinhar o sensor com o ar-condicionado.</li><li>Se o sensor estiver offline, peça ao franqueado que desconecte-o por 2 minutos e, depois, religue. Verifique se o sensor ficou online.</li><li>Se o sensor continuar offline ou o ar-condicionado não ligar mesmo com o sensor online e alinhado, faça testes adicionais para identificar o problema.</li></ol>',
        },
        {
          id: 'configurar-sensor-esp8266',
          title: 'Como configurar/atualizar o sensor',
          keywords: ['ar-condicionado', 'sensor', 'ESP8266', 'ESP8266Flasher', 'plaquinha'],
          body: '<h4>Configuração da plaquinha do sensor do ar-condicionado</h4><ol><li>Solicite ao franqueado que efetue a conexão da plaquinha do sensor do ar-condicionado ao totem, utilizando um cabo de dados USB.</li><li>Uma vez conectada, acesse à loja e faça o envio do arquivo correspondente ao modelo do ar-condicionado, juntamente com o programa <strong>ESP8266Flasher</strong>.</li><li>Após a transferência dos arquivos, abra o programa <strong>ESP8266Flasher</strong> e acesse a aba "Config". Clique no primeiro ícone de engrenagem e selecione o arquivo específico do ar-condicionado que foi previamente enviado.</li><li>Retorne à aba "Operation" e clique no botão "Flash(F)" para iniciar o processo de atualização. Aguarde a conclusão do upload do arquivo.</li></ol>',
        },
      ],
    },
    {
      id: 'roupas',
      group: 'helpdesk',
      title: 'Problemas com as roupas',
      icon: '/fac/img/Icons/roupa-suja.svg',
      summary: 'Roupas sem cheiro, manchadas ou esquecidas na loja.',
      procedures: [
        {
          id: 'sem-cheiro',
          title: 'Roupas saíram sem cheiro',
          keywords: ['roupas', 'cheiro', 'fragrância', 'cesto de medidas', 'sabão'],
          body: '<h4>Roupas saíram sem cheiro</h4><ol><li>Inicialmente, solicite que o cliente forneça seu CPF ou endereço de e-mail para identificação no sistema.</li><li>Verifique as imagens das câmeras para confirmar se o cliente utilizou corretamente o cesto de medidas durante a lavagem.</li></ol><h4>Cliente utilizou o cesto de medidas corretamente</h4><ul><li>Pergunte se deseja realizar uma nova lavagem para corrigir o problema.</li><li>Se optar por nova lavagem, solicite o código da lavadora, proceda com a liberação e registre a ocorrência.</li><li>Se desejar reembolso, informe que deve encaminhar solicitação para <strong>atendimento@lavanderia60minutos.com.br</strong>.</li></ul><h4>Cliente não utilizou o cesto de medidas corretamente</h4><ul><li>Verifique se o cliente é novo e analise nas câmeras a quantidade de roupas.</li><li>Cliente novo com quantidade não excessiva: instrua sobre termos de uso e conceda lavagem de cortesia. Registre ocorrência.</li><li>Cliente antigo sem histórico similar: oriente sobre uso correto e libere lavagem de cortesia. Registre ocorrência.</li><li>Cliente antigo com ocorrências anteriores: não libere nova lavagem; oriente novamente. Registre ocorrência.</li><li>Para reembolso, oriente e-mail para <strong>atendimento@lavanderia60minutos.com.br</strong>.</li></ul>',
        },
        {
          id: 'manchadas',
          title: 'Roupas saíram manchadas',
          keywords: ['roupas', 'manchadas', 'mancha', 're-lavagem', 'reembolso'],
          body: '<h4>Roupas saíram manchadas</h4><ol><li>Inicialmente, solicite que o cliente forneça seu CPF ou endereço de e-mail para identificação no sistema.</li><li>Pergunte ao cliente se ele deseja realizar uma nova lavagem para corrigir o problema. Se optar pela re-lavagem, instrua-o a separar as roupas manchadas em um cesto de medidas e proceda com a liberação da nova lavagem. Registre a ocorrência em seu cadastro.</li><li>Caso o cliente não deseje uma nova lavagem, efetue o reembolso do crédito no cadastro do cliente e registre a ocorrência.</li></ol>',
        },
        {
          id: 'esqueceu-roupas',
          title: 'Cliente esqueceu as roupas na loja',
          keywords: ['roupas', 'esqueceu', 'esquecidas', 'franqueado', 'cestos'],
          body: '<h4>Cliente esqueceu as roupas na loja</h4><ol><li>É importante ressaltar que a lavanderia não se responsabiliza por roupas esquecidas nas lojas.</li><li>Se um cliente informar que outro cliente esqueceu suas roupas dentro da máquina, gentilmente solicite que ele retire as roupas do cliente desatento da máquina e as coloque em um cesto de medidas da lavanderia.</li><li>Em seguida, entre em contato com o franqueado para informar a situação e solicitar que ele vá à lavanderia para retirar as roupas do cliente que esqueceu, guardando-as temporariamente na área de serviço até que o cliente se manifeste.</li></ol>',
        },
      ],
    },
    {
      id: 'pagamento',
      group: 'helpdesk',
      title: 'Problemas no pagamento',
      icon: '/fac/img/Icons/Erro-no-pagamento.svg',
      summary: 'Créditos não contabilizados e débito em cartão na loja física.',
      procedures: [
        {
          id: 'creditos-nao-constam',
          title: 'Pagamento feito e os créditos não constam no cadastro',
          keywords: ['pagamento', 'créditos', 'cadastro', 'NRS', 'estorno'],
          body: '<h4>Pagamento feito e os créditos não constam no cadastro</h4><p><strong>Loja Física:</strong> Abrir um formulário para o CS-Clientes para que seja verificado → Gerar ocorrência.</p><p><strong>Loja Online:</strong> Em horário comercial, solicitar que o CS-Clientes identifique o pagamento e adicione o valor em créditos no cadastro do cliente. Fora do horário comercial, abrir formulário para que o CS-Clientes realize a verificação → Gerar ocorrência.</p><h4>Solicitação de estorno</h4><ol><li>Abrir um formulário para o CS-Clientes para que seja verificado.</li><li>Gerar ocorrência.</li></ol>',
        },
        {
          id: 'debitou-cartao-loja-fisica',
          title: 'Debitou do cartão e não contabilizou (loja física)',
          keywords: ['cartão', 'débito', 'crédito', 'estorno', 'banco', 'loja física'],
          body: '<h4>Debitou do cartão e não contabilizou</h4><ol><li>Neste caso, não é permitido efetuar o reembolso do crédito ao cliente, mesmo que ele apresente o comprovante de pagamento.</li><li>Em algumas situações, caso o valor seja debitado do cartão mas não contabilizado no cadastro, é provável que o banco identifique a falha e efetue estorno automático. O prazo varia de 30 minutos a 24 horas, dependendo do banco.</li><li>Por essa razão, não efetue reembolso de crédito. Solicite que o cliente encaminhe e-mail para <strong>atendimento@lavanderia60minutos.com.br</strong> com: bandeira do cartão, últimos 4 dígitos, método de pagamento (Débito ou Crédito) e imagem das cobranças na fatura.</li></ol>',
        },
      ],
    },
    {
      id: 'nota-fiscal',
      group: 'helpdesk',
      title: 'Nota Fiscal',
      icon: '/fac/img/Icons/pagamento-cartao.svg',
      summary: 'Cliente não recebeu a nota fiscal.',
      procedures: [
        {
          id: 'cliente-nao-recebeu',
          title: 'Nota Fiscal — Cliente não recebeu',
          keywords: ['nota fiscal', 'NF', 'emissão', 'download', 'reemissão'],
          body: '<h4>Nota Fiscal — Cliente não recebeu</h4><ol><li>Solicite o CPF do cliente.</li><li>Acesse o sistema administrativo e localize a compra correspondente.</li><li>Verifique se a nota fiscal foi emitida.</li><li><strong>Nota fiscal emitida?</strong><ul><li><strong>Sim:</strong> Clique no ícone da Nota Fiscal para efetuar o download → Encaminhe a Nota Fiscal ao cliente → Gerar ocorrência.</li><li><strong>Não:</strong> Execute o procedimento de reemissão da Nota Fiscal conforme aprendido no treinamento.<ul><li><strong>Conseguiu reemitir?</strong><ul><li><strong>Sim:</strong> Realize o download e encaminhe ao cliente → Gerar ocorrência.</li><li><strong>Não:</strong> Peça ao cliente que envie e-mail para <strong>atendimento@lavanderia60minutos.com.br</strong> informando CPF, dados da compra e solicitando emissão → Gerar ocorrência.</li></ul></li></ul></li></ul></li></ol>',
        },
      ],
    },
    {
      id: 'cadastro',
      group: 'helpdesk',
      title: 'Cadastro',
      icon: '/fac/img/Icons/suporte-ao-cliente.svg',
      summary: 'Alteração de senha e dados de contato do cliente.',
      procedures: [
        {
          id: 'alteracao-dados',
          title: 'Cadastro — Alteração de Dados',
          keywords: ['cadastro', 'senha', 'CPF', 'e-mail', 'telefone', 'dados'],
          body: '<h4>Alterar Senha</h4><ol><li>Solicite o CPF do cliente.</li><li>Solicite uma nova senha de 4 dígitos.</li><li>Altere a senha no sistema admin.</li><li>Gerar ocorrência.</li></ol><p><strong>OBS:</strong> Apenas o titular da conta está autorizado a alterar os dados. Certifique-se de confirmar a identidade antes de prosseguir.</p><h4>Alterar Dados de Contato</h4><ol><li>Solicite o CPF do cliente.</li><li>Verifique qual informação o cliente deseja atualizar.</li><li>Altere no sistema admin.</li><li>Gerar ocorrência.</li></ol><p><strong>OBS:</strong> Apenas o titular da conta está autorizado a alterar os dados. Certifique-se de confirmar a identidade antes de prosseguir.</p>',
        },
      ],
    },
    {
      id: 'infraestrutura',
      group: 'helpdesk',
      title: 'Infraestrutura',
      icon: '/fac/img/Icons/Ar-condicionado.svg',
      summary: 'Problemas de ar-condicionado reportados pelo cliente (NRS).',
      procedures: [
        {
          id: 'ar-condicionado-nrs',
          title: 'Problemas na Infraestrutura — Ar-condicionado',
          keywords: ['infraestrutura', 'ar-condicionado', 'temperatura', 'ping', 'sensor', 'NRS'],
          body: '<h4>O ar-condicionado não liga ao inserir o CPF no totem</h4><ol><li>Acesse o totem da loja de forma remota.</li><li>Realize um teste de ping no ar-condicionado para verificar se ele está online.</li><li><strong>O ar-condicionado está respondendo ao ping?</strong><ul><li><strong>Sim:</strong> Envie um comando para alterar a temperatura.<ul><li><strong>Ar-condicionado recebeu o comando?</strong><ul><li><strong>Sim:</strong> Gerar ocorrência.</li><li><strong>Não:</strong> Informe imediatamente ao franqueado (sensor provavelmente desalinhado) → Informe ao cliente → Gerar ocorrência.</li></ul></li></ul></li><li><strong>Não:</strong> Informe imediatamente ao franqueado (ar-condicionado fora de rede) → Informe ao cliente → Gerar ocorrência.</li></ul></li></ol><h4>Alterar a temperatura do ar-condicionado</h4><ol><li>Acesse o sistema de gerenciamento de lojas.</li><li>Altere a temperatura.</li><li><strong>Temperatura alterada corretamente?</strong><ul><li><strong>Sim:</strong> Gerar ocorrência.</li><li><strong>Não:</strong> Acesse o totem remotamente → Realize ping no ar-condicionado.<ul><li><strong>Respondendo ao ping?</strong><ul><li><strong>Sim:</strong> Envie comando via CMD para alterar temperatura.<ul><li><strong>Recebeu o comando?</strong> Sim → Gerar ocorrência; Não → Informar franqueado (sensor desalinhado) → Gerar ocorrência.</li></ul></li><li><strong>Não:</strong> Informar franqueado (fora de rede) → Informe ao cliente → Gerar ocorrência.</li></ul></li></ul></li></ul></li></ol>',
        },
      ],
    },
    {
      id: 'itens-esquecidos',
      group: 'helpdesk',
      title: 'Itens Esquecidos',
      icon: '/fac/img/Icons/location.svg',
      summary: 'Roupas e objetos esquecidos ou encontrados na loja.',
      procedures: [
        {
          id: 'itens-na-loja',
          title: 'Itens Esquecidos na Loja',
          keywords: ['esquecidos', 'objetos', 'roupas', 'franqueado', 'devolução'],
          body: '<h4>Roupas Esquecidas</h4><p><strong>Cliente localizou as roupas ainda dentro das máquinas:</strong></p><ol><li>Solicitar que o cliente retire as roupas e as coloque em um dos cestos de medidas disponíveis na loja.</li><li>Informar ao franqueado sobre as roupas esquecidas na loja.</li></ol><p><strong>Cliente encontrou as roupas fora da máquina:</strong></p><ol><li>Informar ao franqueado sobre as roupas esquecidas na loja.</li></ol><h4>Objetos Esquecidos ou Encontrados</h4><ol><li>Informar ao franqueado que deve ir à loja retirar o objeto e contatar o CS-Clientes para localizar o cliente e providenciar a devolução.</li></ol>',
        },
      ],
    },
    {
      id: 'cupons',
      group: 'helpdesk',
      title: 'Problemas com Cupons',
      icon: '/fac/img/Icons/sugestao.svg',
      summary: 'Cupom não funciona ou cliente não recebeu cupom.',
      procedures: [
        {
          id: 'cupom-nao-funciona',
          title: 'Cupom não está funcionando',
          keywords: ['cupom', 'desconto', 'créditos', 'validade', 'loja específica'],
          body: '<h4>Cupom não está funcionando</h4><ol><li>Solicite ao cliente o código do cupom e verifique no sistema Admin.</li><li><strong>Cupom está ativo?</strong><ul><li><strong>Sim:</strong> Abrir formulário para o CS-Clientes solicitando verificação → Gerar ocorrência.</li><li><strong>Não:</strong> Acompanhar inserção do cupom no totem.<ul><li><strong>Uso correto:</strong> Formulário CS-Clientes para adicionar valor em créditos → Gerar ocorrência.</li><li><strong>Não usou corretamente:</strong> Orientar uso correto → Gerar ocorrência.</li></ul></li></ul></li><li><strong>Cupom é específico para alguma loja?</strong><ul><li><strong>Sim:</strong> Orientar que só pode usar na loja específica → Gerar ocorrência.</li><li><strong>Não:</strong> Acompanhar inserção no totem (mesmo fluxo acima).</li></ul></li><li><strong>Cupom está fora do período de validade?</strong><ul><li><strong>Sim:</strong> Informar período de validade → Gerar ocorrência.</li><li><strong>Não:</strong> Acompanhar inserção no totem (mesmo fluxo acima).</li></ul></li></ol>',
        },
        {
          id: 'cliente-nao-recebeu-cupom',
          title: 'Cliente não recebeu cupom',
          keywords: ['cupom', 'e-mail', 'telefone', 'CS-Clientes', 'cadastro'],
          body: '<h4>Cliente não recebeu cupom</h4><ol><li>Verificar com o cliente se o e-mail e o telefone cadastrados estão corretos.</li><li><strong>Dados corretos?</strong><ul><li><strong>Sim:</strong> Em horário comercial, solicitar ao CS-Clientes verificação do motivo. Fora do horário, orientar e-mail para <strong>atendimento@lavanderia60minutos.com.br</strong> → Gerar ocorrência.</li><li><strong>Não:</strong> Solicitar dados corretos e atualizar cadastro → Gerar ocorrência.</li></ul></li></ol>',
        },
      ],
    },
  ];

  let CATEGORIES = [];
  let canEdit = false;
  const customCategoryIds = new Set();
  const customProcedureKeys = new Set();

  function cloneCategories(source) {
    return JSON.parse(JSON.stringify(source || []));
  }

  function resetCategories() {
    CATEGORIES = cloneCategories(BASE_CATEGORIES);
  }

  function trackCustomMeta(meta = {}) {
    customCategoryIds.clear();
    customProcedureKeys.clear();
    (meta.category_ids || []).forEach((id) => customCategoryIds.add(id));
    (meta.procedure_keys || []).forEach((key) => customProcedureKeys.add(key));
  }

  function mergeCustomStore(store = {}) {
    resetCategories();
    const byId = Object.fromEntries(CATEGORIES.map((cat) => [cat.id, cat]));

    for (const category of store.categories || []) {
      if (!category?.id) continue;
      const procedures = (category.procedures || []).map((proc) => ({ ...proc, custom: true }));
      if (byId[category.id]) {
        byId[category.id].procedures.push(...procedures);
        continue;
      }
      const customCategory = {
        ...category,
        custom: true,
        procedures,
      };
      CATEGORIES.push(customCategory);
      byId[category.id] = customCategory;
    }

    for (const entry of store.procedures || []) {
      const categoryId = entry?.category_id;
      const category = byId[categoryId];
      if (!category || !entry?.id) continue;
      category.procedures.push({
        id: entry.id,
        title: entry.title,
        keywords: entry.keywords || [],
        body: entry.body || '',
        custom: true,
      });
    }
  }

  async function loadCustomEntries() {
    resetCategories();
    canEdit = false;
    trackCustomMeta();

    try {
      const fetcher = window.Lav60Auth?.panelFetch || ((url) => fetch(url, { credentials: 'same-origin' }));
      const res = await fetcher('/api/support/custom');
      if (!res.ok) return { ok: false };
      const data = await res.json();
      mergeCustomStore(data.store || {});
      trackCustomMeta(data.meta || {});
      canEdit = Boolean(data.can_edit);
      return { ok: true, canEdit, persistence: data.persistence || null };
    } catch {
      return { ok: false };
    }
  }

  function isCustomProcedure(categoryId, procedureId) {
    return customProcedureKeys.has(`${categoryId}:${procedureId}`);
  }

  function isCustomCategory(categoryId) {
    return customCategoryIds.has(categoryId);
  }

  resetCategories();

  function findProcedure(categoryId, procedureId) {
    const category = CATEGORIES.find((item) => item.id === categoryId);
    if (!category) return null;

    const procedure = category.procedures.find((item) => item.id === procedureId);
    if (!procedure) return null;

    return {
      ...procedure,
      categoryId: category.id,
      categoryTitle: category.title,
      categoryGroup: category.group,
      categoryIcon: category.icon,
    };
  }

  function search(query) {
    const normalized = String(query || '').trim().toLowerCase();
    if (!normalized) return [];

    const results = [];

    for (const category of CATEGORIES) {
      for (const procedure of category.procedures) {
        const searchable = [
          category.id,
          category.title,
          category.summary,
          procedure.id,
          procedure.title,
          ...(procedure.keywords || []),
          procedure.body.replace(/<[^>]+>/g, ' '),
        ]
          .join(' ')
          .toLowerCase();

        if (searchable.includes(normalized)) {
          results.push({
            categoryId: category.id,
            procedureId: procedure.id,
            title: procedure.title,
            categoryTitle: category.title,
          });
        }
      }
    }

    return results;
  }

  const searchSuggestions = [
    'maquineta',
    'microtef',
    'conf.ini',
    'lavadora',
    'secadora',
    'offline',
    'ping',
    'DE1',
    'OE',
    'UE',
    'noteiro',
    'mikrotik',
    'winbox',
    'totem',
    'ativação',
    'ar-condicionado',
    'ESP8266',
    'roupas',
    'manchadas',
    'pagamento',
    'cartão',
    'nota fiscal',
    'cadastro',
    'cupom',
    'itens esquecidos',
  ];

  window.Lav60SupportCatalog = {
    MAP_REGIONS,
    get CATEGORIES() { return CATEGORIES; },
    BASE_CATEGORIES,
    findProcedure,
    search,
    searchSuggestions,
    loadCustomEntries,
    isCustomProcedure,
    isCustomCategory,
    get canEdit() { return canEdit; },
  };
})();
