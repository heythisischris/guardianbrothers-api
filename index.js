const AWS = require('aws-sdk');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const poolConfig = {
    user: process.env.user,
    host: process.env.host,
    database: process.env.database,
    password: process.env.password,
    port: process.env.port
};
const pool = new Pool(poolConfig);
const { formatEmailBody } = require('./email.js');

function encodeForm(data) {
    return Object.keys(data).map(key => encodeURIComponent(key) + '=' + encodeURIComponent(data[key])).join('&');
}

exports.handler = async (event, context) => {
    console.log("BEGIN guardianbrothers: ", { path: event.path, httpMethod: event.httpMethod, body: event.body, queryStringParameters: event.queryStringParameters });

    if (event.triggerSource) {
        if (['TokenGeneration_Authentication', 'TokenGeneration_RefreshTokens'].includes(event.triggerSource)) {
            event.response = {
                "claimsOverrideDetails": {
                    "claimsToAddOrOverride": {
                        "https://hasura.io/jwt/claims": JSON.stringify({
                            "x-hasura-allowed-roles": ["user"],
                            "x-hasura-default-role": "user",
                            "x-hasura-user-id": event.request.userAttributes.sub
                        })
                    }
                }
            };
            return context.done(null, event);
        }
        else if (event.triggerSource === 'CustomMessage_SignUp') {
            event.response.emailSubject = `Confirm your registration, ${event.request.userAttributes['given_name']}!`;
            event.response.emailMessage = formatEmailBody(`Hello ${event.request.userAttributes['given_name']},<p><a href="https://lambda.guardianbrothers.com/confirm?username=${event.userName}&code=${event.request.codeParameter}&email=${event.request.userAttributes.email}">Click this link to complete your registration.</a><p>Thank you,<br>Guardian Brothers<div style="display:none"><a>${event.request.codeParameter}</a><a>${event.request.codeParameter}</a></div>`, event.request.userAttributes.email);
            return context.done(null, event);
        }
        else if (event.triggerSource === 'PostConfirmation_ConfirmSignUp') {
            const pool = new Pool(poolConfig);
            await pool.query(`INSERT INTO users(id, email, first_name, last_name, address, phone) VALUES($1, $2, $3, $4, $5, $6)`, [event.request.userAttributes['sub'], event.request.userAttributes['email'], event.request.userAttributes['given_name'], event.request.userAttributes['family_name'], event.request.userAttributes['address'], event.request.userAttributes['website']]);
            //send welcome email
            AWS.config.update({ region: 'us-east-1' });
            await new AWS.SES().sendEmail({
                Destination: { ToAddresses: [event.request.userAttributes['email']] },
                Message: {
                    Subject: { Data: `Welcome to Guardian Brothers, ${event.request.userAttributes['given_name']}!` },
                    Body: {
                        Html: { Data: formatEmailBody(`Hello ${event.request.userAttributes['given_name']},<p><a href="https://guardianbrothers.com/login?email=${event.request.userAttributes['email']}">Click this link to login.</a><p>Thank you,<br>Guardian Brothers`, event.request.userAttributes['email']) }
                    },
                },
                Source: 'Guardian Brothers <noreply@guardianbrothers.com>'
            }).promise();

            return context.done(null, event);
        }
        else if (event.triggerSource === 'CustomMessage_ForgotPassword') {
            event.response.emailSubject = `Reset your password, ${event.request.userAttributes['given_name']}`;
            event.response.emailMessage = formatEmailBody(`Hello ${event.request.userAttributes['given_name']},<p>We received a request to reset your password.</p><p><a href="https://staging.guardianbrothers.com/set?email=${event.request.userAttributes.email}&code=${event.request.codeParameter}">Click this link to set your new password.</a><p>If you did not request this, you can ignore this email.</p><p>Thank you,<br>Guardian Brothers<div style="display:none"><a>${event.request.codeParameter}</a><a>${event.request.codeParameter}</a></div>`, event.request.userAttributes['email']);
            return context.done(null, event);
        }
        else if (event.triggerSource === 'PostConfirmation_ConfirmForgotPassword') {
            //send email letting user know someone reset their password
            AWS.config.update({ region: 'us-east-1' });
            await new AWS.SES().sendEmail({
                Destination: { ToAddresses: [event.request.userAttributes['email']] },
                Message: {
                    Subject: { Data: `Alert: you changed your password, ${event.request.userAttributes['given_name']}` },
                    Body: {
                        Html: { Data: formatEmailBody(`hey there, ${event.request.userAttributes['given_name']},<p>You've successfully changed your password! If you did not do this, we highly recommend changing your password immediately.</p><p><a href="https://staging.guardianbrothers.com/reset?email=${event.request.userAttributes.email}">Click this link to change your password again.</a><p>Otherwise, you can ignore this email.</p><p>Thank you,<br>Guardian Brothers`, event.request.userAttributes['email']) }
                    },
                },
                Source: 'Guardian Brothers <noreply@guardianbrothers.com>'
            }).promise();
            return context.done(null, event);
        }
        else if (event.triggerSource === 'CustomMessage_UpdateUserAttribute') {
            event.response.emailSubject = `Confirm new email address`;
            event.response.emailMessage = `confirm new email`;
            return context.done(null, event);
        }
    }
    else if (event.path === '/confirm') {
        const cisp = new AWS.CognitoIdentityServiceProvider();
        await cisp.confirmSignUp({ ClientId: process.env.clientId, ConfirmationCode: event.queryStringParameters.code, Username: event.queryStringParameters.username }).promise();
        return { statusCode: 302, body: null, headers: { 'Access-Control-Allow-Origin': '*', 'Location': `https://staging.guardianbrothers.com/login?email=${event.queryStringParameters.email}` } };
    }
    else if (event.path === '/callback') {
        let response1 = await fetch('https://api.tdameritrade.com/v1/oauth2/token', {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: encodeForm({
                grant_type: 'authorization_code',
                code: decodeURIComponent(event.queryStringParameters.code),
                access_type: 'offline',
                redirect_uri: process.env.redirect_uri,
                client_id: process.env.client_id
            })
        });
        response1 = await response1.json();
        console.log(response1);
        try {
            await pool.query("UPDATE configuration SET value = $1 WHERE id = 'refresh_token'", [response1.refresh_token]);
            return { statusCode: 200, body: JSON.stringify({ response: "success", message: "saved new refresh_token. this will last for another 90 days." }), headers: { 'Access-Control-Allow-Origin': '*' } };
        }
        catch (err) {
            console.log(err);
            return { statusCode: 400, body: JSON.stringify({ response: "error", message: "there was an error, we couldn't save a new refresh_token." }), headers: { 'Access-Control-Allow-Origin': '*' } };
        }
    }
    else if (event.path === '/save') {
        let refresh_token = await pool.query("SELECT value FROM configuration WHERE id='refresh_token'");
        let response1 = await fetch('https://api.tdameritrade.com/v1/oauth2/token', {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: encodeForm({
                grant_type: 'refresh_token',
                refresh_token: refresh_token.rows[0].value,
                redirect_uri: process.env.redirect_uri,
                client_id: process.env.client_id
            })
        });
        response1 = await response1.json();
        let response2 = await fetch(`https://api.tdameritrade.com/v1/accounts/${process.env.account_number}`, {
            method: "GET",
            headers: { Authorization: `Bearer ${response1.access_token}` }
        });
        response2 = await response2.json();
        console.log(response2);
        let shares_outstanding = await pool.query("SELECT value FROM configuration WHERE id='shares_outstanding'");
        try {
            let response3 = await pool.query('INSERT INTO liquidation_value(value, shares) VALUES($1, $2) RETURNING *', [response2.securitiesAccount.currentBalances.liquidationValue, parseFloat(shares_outstanding.rows[0].value)]);

            // await refreshStockData(response1.access_token);
        }
        catch (err) {
            console.log(err);
        }

        //let's track orders now
        let fromEnteredTime = new Date();
        fromEnteredTime.setDate(fromEnteredTime.getDate() - 7);
        fromEnteredTime = fromEnteredTime.toISOString().split('T')[0];
        let toEnteredTime = new Date();
        toEnteredTime.setDate(toEnteredTime.getDate() + 1);
        toEnteredTime = toEnteredTime.toISOString().split('T')[0];

        let orders = await fetch(`https://api.tdameritrade.com/v1/accounts/${process.env.account_number}/orders?status=FILLED&fromEnteredTime=${fromEnteredTime}&toEnteredTime=${toEnteredTime}`, {
            method: "GET",
            headers: { Authorization: `Bearer ${response1.access_token}` }
        });
        orders = await orders.json();

        let databaseStocks = await pool.query("SELECT * FROM stock");

        let parseResponse = orders.map(obj => {
            let name = databaseStocks.rows.filter(innerObj => innerObj.id === obj.orderLegCollection[0].instrument.symbol);
            return ({
                orderId: obj.orderId,
                ticker: obj.orderLegCollection[0].instrument.symbol,
                company: name.length > 0 ? name[0].name : obj.orderLegCollection[0].instrument.symbol,
                date: obj.closeTime,
                order: obj.orderLegCollection[0].instruction,
                shares: obj.orderLegCollection[0].quantity
            });
        });

        for (const row of parseResponse) {
            try {
                await pool.query(`INSERT INTO trades ("id", "ticker", "company", "date", "order", "shares") VALUES($1, $2, $3, $4, $5, $6);`, [row.orderId, row.ticker, row.company, row.date, row.order, row.shares]);
            }
            catch (err) {
                console.log(err);
            }
        }

        return { statusCode: 200, body: JSON.stringify('success'), headers: { 'Access-Control-Allow-Origin': '*' } };
    }
    else if (event.path === '/auth') {
        return { statusCode: 302, headers: { Location: process.env.auth_uri } };
    }
    else if (event.path === '/stats' || event.path === '/stats/equityFund1') {
        try {
            let response = await pool.query('SELECT * FROM liquidation_value ORDER BY id DESC');
            return { statusCode: 200, body: JSON.stringify(response.rows), headers: { 'Access-Control-Allow-Origin': '*' } };
        }
        catch (err) {
            console.log(err);
            return { statusCode: 400, body: "there was an error", headers: { 'Access-Control-Allow-Origin': '*' } };
        }
    }
    else if (event.path === '/stats/hybridFund') {
        return { statusCode: 200, body: JSON.stringify([{ value: 1000, shares: 1000 }, { value: 1000, shares: 1000 }]), headers: { 'Access-Control-Allow-Origin': '*' } };
    }
    else if (event.path === '/update') {
        if (event.queryStringParameters) {
            if (event.queryStringParameters.shares) {
                try {
                    await pool.query("UPDATE configuration SET value = $1 WHERE id = 'shares_outstanding'", [event.queryStringParameters.shares]);
                    return { statusCode: 200, body: `Shares outstanding updated to ${event.queryStringParameters.shares}`, headers: { 'Access-Control-Allow-Origin': '*' } };
                }
                catch (err) {
                    console.log(err);
                    return { statusCode: 400, body: "there was an error", headers: { 'Access-Control-Allow-Origin': '*' } };
                }
            }
            else {
                return { statusCode: 400, body: "There was error processing your update- if you're trying to update the shares outstanding, make sure you follow this URL format: https://lambda.guardianbrothers.com/update?shares=3000", headers: { 'Access-Control-Allow-Origin': '*' } };
            }
        }
        else {
            return { statusCode: 400, body: "There was error processing your update- if you're trying to update the shares outstanding, make sure you follow this URL format: https://lambda.guardianbrothers.com/update?shares=3000", headers: { 'Access-Control-Allow-Origin': '*' } };
        }
    }
    else if (event.path === '/positions' || event.path === '/positions/equityFund1') {
        let refresh_token = await pool.query("SELECT value FROM configuration WHERE id='refresh_token'");
        let response1 = await fetch('https://api.tdameritrade.com/v1/oauth2/token', {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: encodeForm({
                grant_type: 'refresh_token',
                refresh_token: refresh_token.rows[0].value,
                redirect_uri: process.env.redirect_uri,
                client_id: process.env.client_id
            })
        });
        response1 = await response1.json();
        let response2 = await fetch(`https://api.tdameritrade.com/v1/accounts/${process.env.account_number}?fields=positions`, {
            method: "GET",
            headers: { Authorization: `Bearer ${response1.access_token}` }
        });
        response2 = await response2.json();
        //console.log(response2);
        let positionsOrdered = response2.securitiesAccount.positions.sort((a, b) => b.marketValue - a.marketValue);
        /*
            for (let obj of positionsOrdered) {
                let response3 = await fetch(`https://api.tdameritrade.com/v1/instruments?apikey=JXCRKTH2PS6GI5GCPNAO2OORPWIGHTYY&projection=fundamental&symbol=${obj.instrument.symbol}`, {
                    method: "GET",
                    headers: { Authorization: `Bearer ${response1.access_token}` }
                });
                response3 = await response3.json();
                //console.log(response3);
                obj.marketCap = response3[obj.instrument.symbol].fundamental.marketCap;
            }
        */
        let databaseStocks = await pool.query("SELECT * FROM stock");

        for (let obj of positionsOrdered) {
            let findStock = databaseStocks.rows.filter(innerObj => innerObj.id === obj.instrument.symbol)[0];
            if (findStock) {
                obj.marketCap = findStock.market_cap;
                obj.sector = findStock.sector;
                obj.name = findStock.name;
                obj.industry = findStock.industry;
                obj.peRatio = findStock.pe_ratio;
                obj.dividendYield = findStock.dividend_yield;
                obj.priceBookRatio = findStock.price_book_ratio;
                obj.beta = findStock.beta;
            }
        }
        return { statusCode: 200, body: JSON.stringify({ positions: response2.securitiesAccount.positions, liquidationValue: response2.securitiesAccount.currentBalances.liquidationValue, cashBalance: response2.securitiesAccount.currentBalances.cashBalance }), headers: { 'Access-Control-Allow-Origin': '*' } };
    }
    else if (event.path === '/positions/hybridFund') {
        return { statusCode: 200, body: JSON.stringify({ positions: [], liquidationValue: 0, cashBalance: 0 }), headers: { 'Access-Control-Allow-Origin': '*' } };
    }
    else if (event.path === '/refreshstocks') {
        let refresh_token = await pool.query("SELECT value FROM configuration WHERE id='refresh_token'");
        let response1 = await fetch('https://api.tdameritrade.com/v1/oauth2/token', {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: encodeForm({
                grant_type: 'refresh_token',
                refresh_token: refresh_token.rows[0].value,
                redirect_uri: process.env.redirect_uri,
                client_id: process.env.client_id
            })
        });
        response1 = await response1.json();
        // await refreshStockData(response1.access_token);
        return { statusCode: 200, body: "success! we're actually no longer refreshing stock data because intrinio no longer works.", headers: { 'Access-Control-Allow-Origin': '*' } };
    }
    else if (event.path === '/trades' || event.path === '/trades/equityFund1') {
        let trades = await pool.query("SELECT * FROM trades WHERE date>='2021-01-01' ORDER BY date DESC");
        return {
            statusCode: 200,
            body: JSON.stringify(trades.rows),
            headers: { 'Access-Control-Allow-Origin': '*' }
        };
    }
    else if (event.path === '/trades/hybridFund') {
        return { statusCode: 200, body: JSON.stringify([]), headers: { 'Access-Control-Allow-Origin': '*' } };
    }
    else if (event.path === '/contact') {
        event.body ? event.body = JSON.parse(event.body) : event.body = {};
        AWS.config.update({ region: 'us-east-1' });
        await new AWS.SES().sendEmail({
            Destination: {
                ToAddresses: ['fernando@guardianbrothers.com', 'chris+gb@heythisischris.com']
            },
            Message: {
                Body: {
                    Html: { Data: event.body.message },
                    Text: { Data: event.body.message }
                },
                Subject: {
                    Data: `${event.body.firstName} ${event.body.lastName} contacted you from ${event.body.email}`
                }
            },
            Source: 'fernando@guardianbrothers.com',
            ReplyToAddresses: ['fernando@guardianbrothers.com'],
        }).promise();
        return {
            statusCode: 200,
            body: JSON.stringify({ message: "success" }),
            headers: { 'Access-Control-Allow-Origin': '*' }
        };
    }
    else if (event.path === '/hybridcontact') {
        event.body ? event.body = JSON.parse(event.body) : event.body = {};
        const message = formatEmailBody(`Hola ${event.body.firstName} ${event.body.lastName},
            <p/>
            Espero que se encuentre bien y gracias por su interés en nuestro fondo Guardian Hybrid Fund, LP. Además de BTC, ofrecemos un conjunto completo de soluciones de inversión, como fondos criptográfico líquido diversificado y carteras personalizadas de acuerdo a las necesdidades de nuestros cliente
            <p/>
            A continuación se encuentran nuestros materiales de fondo hibrido y un enlace a nuestras otras soluciones de inversión. Tenemos más de 500mil de dólares invertidos en el espacio de activos digitales, por lo que si está buscando obtener exposición, sería genial conectarse. Avíseme si está interesado en hablar más y saber mas acerca de nuestros servicios.
            <p/>
            Agenda tu reunion<br/>
            https://meetings.hubspot.com/guardianbrothers/llamada-de-oportunidad
            <p/>
            Presentación<br/>
            https://hubs.ly/Q01vkCs40
            <p/>
            Fact Sheet<br/>
            https://hubs.ly/Q01vkCn70
            <p/>
            Saludos cordiales,<br/>
            Fernando
            <p/>
            Fernando Guardia<br/>
            +1 (478) 841-4516<br/>
            fernando@guardianbrothers.com
        `, event.body.email);
        await new AWS.SES({ region: 'us-east-1' }).sendEmail({
            Destination: {
                ToAddresses: [event.body.email]
            },
            Message: {
                Body: {
                    Html: { Data: message },
                    Text: { Data: message }
                },
                Subject: {
                    Data: `Guardian Brothers Hybrid Fund`
                }
            },
            Source: 'fernando@guardianbrothers.com',
            ReplyToAddresses: ['fernando@guardianbrothers.com'],
        }).promise();
        const internalMessage = formatEmailBody(`New hybrid fund lead: ${event.body.firstName} ${event.body.lastName} (${event.body.email, event.body.telephone})`, ``);
        await new AWS.SES({ region: 'us-east-1' }).sendEmail({
            Destination: {
                ToAddresses: [
                    'fernando@guardianbrothers.com',
                    'chris+gb@heythisischris.com',
                ]
            },
            Message: {
                Body: {
                    Html: { Data: internalMessage },
                    Text: { Data: internalMessage }
                },
                Subject: {
                    Data: `New hybrid fund lead: ${event.body.firstName} ${event.body.lastName} (${event.body.email}, ${event.body.telephone})`
                }
            },
            Source: 'fernando@guardianbrothers.com',
            ReplyToAddresses: ['fernando@guardianbrothers.com'],
        }).promise();
        await pool.query(`INSERT INTO "mailing_list" (email, first_name, last_name, telephone) VALUES($1, $2, $3, $4) `, [event.body.email, event.body.firstName, event.body.lastName, event.body.telephone]);
        return {
            statusCode: 200,
            body: JSON.stringify({ message: "success" }),
            headers: { 'Access-Control-Allow-Origin': '*' }
        };
    }
    else if (event.path === '/mailinglist') {
        event.body ? event.body = JSON.parse(event.body) : event.body = {};
        await pool.query(`INSERT INTO "mailing_list" (email) VALUES($1) `, [event.body.email]);
        return {
            statusCode: 200,
            body: JSON.stringify({ message: "success" }),
            headers: { 'Access-Control-Allow-Origin': '*' }
        };
    }
    else if (event.path === '/upload') {
        let rows = event.body.split('\r\n').map(obj => obj.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(obj => obj.replace(/"/g, '')));
        const headers = rows.shift();
        const parsedRows = rows.map(obj =>
            headers.map((header, index) => {
                return ({
                    [header]: obj[index]
                });
            }).reduce((acc, x) => {
                for (var key in x) acc[key] = x[key];
                return acc;
            }, {})
        );

        for (const row of parsedRows) {
            await pool.query(`
                INSERT INTO stock(id, name, market_cap, sector, industry, pe_ratio, dividend_yield, price_book_ratio, beta) values($1, $2, $3, $4, $5, $6, $7, $8, $9) 
                ON CONFLICT (id) 
                DO UPDATE SET name=$2, market_cap=$3, sector=$4, industry=$5, pe_ratio=$6, dividend_yield=$7, price_book_ratio=$8, beta=$9`,
                [
                    row['Ticker'],
                    row['Company'],
                    !isNaN(parseFloat(row['Market Cap'])) ? parseFloat(row['Market Cap']) : null,
                    row['Sector'], row['Industry'],
                    !isNaN(parseFloat(row['P/E'])) ? parseFloat(row['P/E']) : null,
                    !isNaN(parseFloat(row['Dividend Yield'])) ? (parseFloat(row['Dividend Yield'].replace('%', '')) / 100) : null,
                    !isNaN(parseFloat(row['P/B'])) ? parseFloat(row['P/B']) : null,
                    !isNaN(parseFloat(row['Beta'])) ? parseFloat(row['Beta']) : null
                ]
            );
        }

        return { statusCode: 200, body: JSON.stringify({ response: "success", message: "updated fundamental stock data using uploaded CSV." }), headers: { 'Access-Control-Allow-Origin': '*' } };
    }
};

let refreshStockData = async (access_token) => {
    //todo- replace refreshStockData's API provider (Intrinio) with a new one
    //cool, now we want to keep track of the names, marketcaps, and sectors for each stock in the portfolio
    let positions = await fetch(`https://api.tdameritrade.com/v1/accounts/${process.env.account_number}?fields=positions`, {
        method: "GET",
        headers: { Authorization: `Bearer ${access_token}` }
    });
    positions = await positions.json();
    for (let obj of positions.securitiesAccount.positions) {
        let marketCap = 0;
        try {
            marketCap = await fetch(`https://api-v2.intrinio.com/securities/${obj.instrument.symbol}/data_point/marketcap/number?api_key=${process.env.intrinio}`);
            marketCap = await marketCap.json();
            if (typeof marketCap !== 'number') { marketCap = 0; }
        }
        catch (err) {
            console.log(err);
        }

        let sector = "Other";
        try {
            sector = await fetch(`https://api-v2.intrinio.com/securities/${obj.instrument.symbol}/data_point/sector/text?api_key=${process.env.intrinio}`);
            sector = await sector.json();
            if (typeof sector === 'object') {
                sector = 'Other';
            }
        }
        catch (err) {
            console.log(err);
        }

        let name = obj.instrument.symbol;
        try {
            name = await fetch(`https://api-v2.intrinio.com/securities/${obj.instrument.symbol}/data_point/name/text?api_key=${process.env.intrinio}`);
            name = await name.json();
        }
        catch (err) {
            console.log(err);
        }

        let industry = "Other";
        try {
            industry = await fetch(`https://api-v2.intrinio.com/securities/${obj.instrument.symbol}/data_point/industry_category/text?api_key=${process.env.intrinio}`);
            industry = await industry.json();
            if (typeof industry === 'object') {
                industry = 'Other';
            }
        }
        catch (err) {
            console.log(err);
        }

        let peRatio = 0;
        try {
            peRatio = await fetch(`https://api-v2.intrinio.com/securities/${obj.instrument.symbol}/data_point/pricetoearnings/number?api_key=${process.env.intrinio}`);
            peRatio = await peRatio.json();
            if (typeof peRatio !== 'number') { peRatio = 0; }
        }
        catch (err) {
            console.log(err);
        }

        let dividendYield = 0;
        try {
            dividendYield = await fetch(`https://api-v2.intrinio.com/securities/${obj.instrument.symbol}/data_point/dividendyield/number?api_key=${process.env.intrinio}`);
            dividendYield = await dividendYield.json();
            if (typeof dividendYield !== 'number') { dividendYield = 0; }
        }
        catch (err) {
            console.log(err);
        }

        let priceBookRatio = 0;
        try {
            priceBookRatio = await fetch(`https://api-v2.intrinio.com/securities/${obj.instrument.symbol}/data_point/pricetobook/number?api_key=${process.env.intrinio}`);
            priceBookRatio = await priceBookRatio.json();
            if (typeof priceBookRatio !== 'number') { priceBookRatio = 0; }
        }
        catch (err) {
            console.log(err);
        }

        let beta = 0;
        try {
            beta = await fetch(`https://api-v2.intrinio.com/securities/${obj.instrument.symbol}/data_point/beta/number?api_key=${process.env.intrinio}`);
            beta = await beta.json();
            if (typeof beta !== 'number') { beta = 0; }
        }
        catch (err) {
            console.log(err);
        }

        try {
            await pool.query("INSERT INTO stock (id, name, market_cap, sector, industry, pe_ratio, dividend_yield, price_book_ratio, beta) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9);", [obj.instrument.symbol, name, marketCap, sector, industry, peRatio, dividendYield, priceBookRatio, beta]);
        }
        catch (err) {
            console.log(err);
            await pool.query("UPDATE stock SET name=$2, market_cap=$3, sector=$4, industry=$5, pe_ratio=$6, dividend_yield=$7, price_book_ratio=$8, beta=$9 WHERE id=$1;", [obj.instrument.symbol, name, marketCap, sector, industry, peRatio, dividendYield, priceBookRatio, beta]);
        }

    }
    return true;
};
