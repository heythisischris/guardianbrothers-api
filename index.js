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

function encodeForm(data) {
    return Object.keys(data).map(key => encodeURIComponent(key) + '=' + encodeURIComponent(data[key])).join('&');
}

exports.handler = async(event) => {
    console.log("BEGIN guardianbrothers: ", { path: event.path, httpMethod: event.httpMethod, body: event.body, queryStringParameters: event.queryStringParameters });
    if (event.path === '/callback') {
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

            await refreshStockData(response1.access_token);
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
    else if (event.path === '/stats') {
        try {
            let response = await pool.query('SELECT * FROM liquidation_value ORDER BY id DESC');
            return { statusCode: 200, body: JSON.stringify(response.rows), headers: { 'Access-Control-Allow-Origin': '*' } };
        }
        catch (err) {
            console.log(err);
            return { statusCode: 400, body: "there was an error", headers: { 'Access-Control-Allow-Origin': '*' } };
        }
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
                return { statusCode: 400, body: "There was error processing your update- if you're trying to update the shares outstanding, make sure you follow this URL format: https://api.guardianbrothers.com/update?shares=3000", headers: { 'Access-Control-Allow-Origin': '*' } };
            }
        }
        else {
            return { statusCode: 400, body: "There was error processing your update- if you're trying to update the shares outstanding, make sure you follow this URL format: https://api.guardianbrothers.com/update?shares=3000", headers: { 'Access-Control-Allow-Origin': '*' } };
        }
    }
    else if (event.path === '/positions') {
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
        await refreshStockData(response1.access_token);
        return { statusCode: 200, body: "success!", headers: { 'Access-Control-Allow-Origin': '*' } };
    }
    else if (event.path === '/trades') {
        let trades = await pool.query("SELECT * FROM trades WHERE date>='2021-01-01' ORDER BY date DESC");
        return {
            statusCode: 200,
            body: JSON.stringify(trades.rows),
            headers: { 'Access-Control-Allow-Origin': '*' }
        };
    }
};

let refreshStockData = async(access_token) => {
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
